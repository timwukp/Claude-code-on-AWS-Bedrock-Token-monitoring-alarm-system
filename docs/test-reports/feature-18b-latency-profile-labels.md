# Feature 18b — inference-profile ids resolved to model names (qa F-PR52-002)

- **Chain:** `intent/latency-profile-labels/`
- **Base:** `main` at `22081a45` (the tip after #52 merged)
- **Type:** follow-up fix to feature-18, found by the UI qa agent on feature-18's own PR
- **Result:** PASS

## What was wrong, and why it is not merely cosmetic

Feature-18 built the by-model latency table straight off CloudWatch's `ModelId` dimension. That
dimension does not always hold a model id: when a request is routed through an **application
inference profile**, CloudWatch reports the series under the profile's id — an opaque twelve-character
string. Three of the ten rows on the dev account were such rows, and two of them were among the
highest-volume series in the window.

The UI qa agent reported it as **F-PR52-002 (LOW)**: *"By-model latency table shows raw
inference-profile IDs instead of resolved model names."* The severity is right for a table, but the
defect sits badly with this page specifically. `/latency` argues that a number is only shown where it
can be attributed — three of five hops are drawn deliberately without numbers for exactly that reason.
A row carrying a real number under a name the reader cannot identify is the same failure pointed the
other way.

## The fix, and the two cases where it refuses to answer

`resolveLabel()` (pure, unit-tested) maps the dimension value back through
`bedrock:ListInferenceProfiles`:

| Input | Label | `via` | `resolvedModel` |
|---|---|---|---|
| a model id, with or without a region prefix | the id, prefix stripped | absent | absent |
| a profile routing to one distinct model | that model | `inference-profile` | set |
| a profile listing one model once per region | that model | `inference-profile` | set |
| a profile routing to **several** distinct models | the profile's name, else its id | `inference-profile` | **absent** |
| an id no profile matches | the id, verbatim | absent | absent |

The last two rows are the point. A multi-model profile's latency is a mixture, so naming one of its
models would be a fabrication — the row keeps the profile name and claims no model, and a test asserts
`resolvedModel` stays absent. An unmatched id (profile deleted since, or the list call denied) keeps
the raw id, because the raw id is at least literally what CloudWatch reported.

`modelId` still holds the unmodified dimension value in every case, so the raw series is always
recoverable from the response.

## The list call is allowed to fail

Any failure of `ListInferenceProfiles` — denial, throttle, transport — returns an empty map and the
endpoint answers with raw ids exactly as it did before. This is specified behaviour, not a swallowed
error: a labelling aid must not be able to fail a metrics read. It also means the single IAM addition
is not load-bearing for availability.

## Gates

| Gate | Result |
|---|---|
| backend `jest` | **222 / 222**, 21 suites (`main` at `22081a45` is 215; this adds 7 cases to the latency suite) |
| backend `tsc --noEmit` | exit 0 |
| frontend `tsc --noEmit` | exit 0 |
| frontend `vite build` | succeeded — `index-CLw0Ol3K.js` |
| `cdk synth --context env=ci` | all 10 stacks |
| `sdlc_ci_gate.py --require-active` | PASSED — all 5 changed source files named in the plan, `Accepted-for` == merge base |
| leak scan | no 12-digit ids, no ARNs, no key material, no customer names |

The 7 new cases are the five rows of the table above plus a multi-model profile with no name (falls
back to its id) and region-stripping applied to a resolved model.

## IAM change — read before deploying, and named to the owner first

`cdk diff Tums-dev-Api` showed exactly one added action and nothing else:

```
│ + │ * │ Allow │ bedrock:ListInferenceProfiles │ AWS:${LatencyFn/ServiceRole} │
```

plus the new function bundle. No table grant, no `bedrock:Invoke*`, no resource-level scope (the
action does not support one). The deploy was **blocked** until the owner explicitly named this grant,
which is the correct outcome: the original authorisation covered deploying the latency feature, not
adding an IAM permission to it afterwards.

Deploy completed in 40.55 s.

## Live validation — deployed `LatencyFn`, real CloudWatch data

Invoked directly with an API-Gateway event carrying real `custom:tenantId` / `admin` claims (no
Cognito session in hand — the same standing limitation as features 15 through 18). Window 7 days,
`200`, 10 model rows:

| Label rendered | `via` | raw `modelId` (the CloudWatch dimension) | invocations |
|---|---|---|---|
| `anthropic.claude-fable-5-1` | — | `us.anthropic.claude-fable-5-1` | 102 |
| `anthropic.claude-fable-5-1` | `inference-profile` | `c5xf7omvk87g` | 2,454 |
| `anthropic.claude-haiku-4-5-20251001-v1:0` | `inference-profile` | `5qevtq09cw39` | 1,324 |
| `anthropic.claude-sonnet-4-6` | `inference-profile` | `5posspchaq1y` | 1 |
| `anthropic.claude-opus-5` | — | `us.anthropic.claude-opus-5` | 4,616 |
| *(5 further direct rows)* | — | region-prefixed model ids | 219 – 5,781 |

**Rows still showing an opaque id: 0.** All three ids qa named resolved, and each resolved row carries
`via: 'inference-profile'` with a `resolvedModel`, while `modelId` still holds the raw dimension value.

No multi-model profile exists on this account, so the refusal branch is covered by unit test only —
stated here rather than implied to be live-verified.

Resolution also makes labels collide, by design: the same model reached directly and through a profile
is two genuinely different series with different latency. Those rows are now separated by their route
(the profile name for profile rows, the region prefix for direct rows). Before this change the
disambiguator reported a profile row as `direct`, which was not just unhelpful but wrong.

## Regression check on the neighbouring endpoints

After the deploy, on the same stack:

| Endpoint | Result |
|---|---|
| `GET /v1/dora/overview` | **200**, 6 repo rows |
| `GET /v1/projects?source=fast` | **200** |

Worth recording because the first attempt at this check failed for reasons that were mine, not the
code's: `dora.ts` routes on `path`/`resource`, so a synthetic event lacking them returns 404, and the
tenants table is `tums-tenants-dev` holding only registry items — real tenant partitions live in the
aggregates table. The tenant used has aggregates but no project rollups, so `projects: 0` is correct
for it; the assertion was the status code.

## Frontend

Built, synced to the dev bucket, CloudFront invalidated, and the bundle **CloudFront actually serves**
fetched back and checked: `via profile` and `multi-model profile` both present in
`index-CLw0Ol3K.js`. Browser render not read — `playwright-mcp` is not available in this session, the
same gap the feature-15, 18 and 22 reports carried. Evidence here is Lambda-, HTTP- and bundle-level.

## Known gaps

- **No browser render check**, as above.
- **The multi-model refusal branch is not live-exercised** — no such profile exists on the account.
- **The `MAX_MODELS` cap of 12 is unchanged**, and resolution does not merge a profile row into its
  direct counterpart. Merging would be wrong (different routes, different latency), but it does mean a
  busy account can spend several of its twelve series on one model.
- **A concurrent Api deploy from a branch cut before this change silently reverts the grant**, and the
  endpoint then degrades to raw ids rather than erroring — silent by design and therefore easy to miss.
  The other active session was told and agreed not to deploy the Api stack until this lands.
- **The qa check that found this was green.** The report said `overall: FAIL` with 3 findings while the
  GitHub check reported success, because `ci-agent/bugfix_agent.py` returns 0 unconditionally since
  #44. The finding was only acted on because the report body was read. That signal defect is still
  open and is not fixed here.
