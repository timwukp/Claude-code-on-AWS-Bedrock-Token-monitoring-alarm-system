# Feature 17 — Athena attribution parity (the Full project view sees the profile tier)

- **Chain:** `intent/athena-attribution-parity/` · **Branch:** `fix/athena-attribution-parity`
  off `main@9274c7f` · **PR:** TBD
- **Origin:** qa run on PR #43 — **F-1101 HIGH** (Full view 99.97% `untagged` vs 20 attributed
  projects in Fast) and **F-1102 LOW** (no thousands separator in currency). Both pre-date #43.
- **Verdict:** PASS — see the live before/after and the residue accounting below.

## What was wrong

The page states a four-tier attribution precedence: **application inference profile tag ▷
`requestMetadata.project_id` ▷ admin identity hint ▷ untagged**. That order was implemented in the
aggregator only, i.e. the Fast (DynamoDB) path. Both Athena statements — `byProject` in
`queries.ts`, which is what the Full toggle actually runs, and the synchronous `/v1/projects` in
`projects.ts` — attributed from `requestMetadata['project_id']` alone.

Profile-routed calls log the **profile ARN as `modelId`** and carry no `project_id`, so the
strongest tier — the one this product recommends and can enforce with IAM — was exactly the one
Athena could not see. A project attributed entirely by profile routing was absent from the Full
view altogether.

**The page's own copy called this divergence "by design". That overstated it.** The historical
part is by design (feature-13 back-filled the *rollups* and left raw logs immutable); the
profile-tier part was a gap. The copy now names which two tiers Full cannot resolve and why.

## Fix

Both statements inline the registry's resolved-profile cache (`REGISTRY#PROFILE`, written by the
aggregator's `resolveUnseenProfiles`, read by `listProfiles()`) — the same self-healing source of
truth the aggregator uses — rather than mirroring it into S3/Glue:

- `queries.ts`: `projectExprFrom()` → `CASE WHEN l.modelId = '<arn>' THEN '<project>' END` with
  **no `ELSE`**, so a non-profile call is `NULL` and the `COALESCE` falls through to the next tier.
  Same `SAFE_SQL_STR` allow-list and failure posture as the existing `buildModelExpr`.
- `projects.ts`: `buildFullSql()` → `WITH profile_map (profile_arn, project_id) AS (VALUES …)`
  left-joined, then `project_mapping` joined on the resolved id for name and cost centre.
  `MAX_PROFILE_ROWS = 400` bounds the statement against Athena's 262 kB limit.
- The fold happens in the `GROUP BY` key, not afterwards in the Lambda — merging profile rows into
  project rows post-query would re-aggregate `COUNT(DISTINCT user_id)` and over-count shared users.
- Empty cache ⇒ the pre-change SQL byte for byte; unreadable cache ⇒ tier disabled with a warning
  naming it; the page never fails.
- A tier-1 row is labelled by project **id** when the CSV has no row; both paths relabel from the
  registry (the page reuses the Fast response it already fetches, before `mergeProjectRows`, so a
  project attributed by both tiers collapses to one row).
- `fmtUsd` → `toLocaleString('en-US', 2 dp)`; `fmtSignedUsd` pinned likewise (an unpinned locale is
  the same defect mirrored).

## Unit tests / gates

| Gate | Result |
|---|---|
| backend `jest` | **178 / 178**, 19 suites (+11 new: `projects-sql.test.ts` ×7, `queries.test.ts` +4) |
| backend `tsc --noEmit` | clean |
| frontend `tsc --noEmit` + `vite build` | clean (no frontend test runner exists; formatter verified by direct evaluation: `13858.35 → $13,858.35`, `1234567.891 → $1,234,567.89`) |
| `cdk synth -c env=ci` | 10 stacks, clean (no infra change) |
| `sdlc_ci_gate.py --require-active --base-sha 9274c7f…` | **PASSED** — 7 source files, all named in the plan; binding matches |

New tests pin: CTE emission; AIP-before-metadata precedence; name/cost-centre resolution; the
empty-profiles fallback equals the old SQL exactly; a single `GROUP BY`; quote-injection
sanitisation (statement quotes stay balanced); the row cap; and for `queries.ts` the no-`ELSE`
CASE, skipping of `untagged`/empty/unsafe values, and tier omission when nothing resolves.

## Live validation (dev, real data)

Method as in features 15/16: no Cognito token in hand, so the **deployed** Lambdas were invoked
directly with an API-Gateway event carrying the tenant's real `custom:tenantId` / `admin` claims.
`Tums-dev-Api` deployed 11:01 (only `ProjectsFn` and `QueriesFn` changed).

### Before / after — `byProject` (the query the Full toggle runs), 90-day window

| | rows | `untagged` | `token-monitoring` |
|---|---|---|---|
| before (qa evidence) | 4 | 222.07M tok / $13,857.95 — **99.97%** | **absent** |
| after | 5 projects (42 project×model rows) | 215.28M / $13,736.63 — **96.60%** | **6.98M / $139.29** |

The submitted SQL was read back from Athena: the project column is
`COALESCE(CASE WHEN l.modelId = '…profile/…' THEN 'token-monitoring' … END, m.project_name,
l.requestMetadata['project_id'], 'untagged')` with the 3 cached profile ARNs.

### Synchronous `/v1/projects`

200, same five projects; the profile-attributed row reads **"Token Usage Monitoring"** with its
registry cost centre (relabel path exercised). Submitted SQL carries `WITH profile_map … (VALUES …)`
(3 rows), the AIP-first `COALESCE`, and `GROUP BY 1, 2`.

### Fast view — unchanged, as required

20 projects, 222.80M tok, `untagged` 17.71M / $1,560.50, `rollupsAsOf` 02:49 UTC.

### The residue is accounted for, not waved at

Fast-attributed minus Full-attributed = 205.09M − 7.58M = **197.5M**, which equals Full's
`untagged` minus Fast's `untagged` = 215.28M − 17.71M = **197.57M**. Nothing is lost; Full simply
has two tiers fewer. An ad-hoc Athena split of every raw-log call with no `project_id` shows
*which* two:

| era | routing | calls | tokens |
|---|---|---|---|
| before the first tagged profile existed (2026-09-17 09:23 UTC) | direct model | 182,466 | **212.63M** |
| after | profile-routed | 3,492 | 7.10M → now attributed by the new tier |
| after | direct model | 6,219 | 2.67M → identity-hint tier's territory |

212.63M + 2.67M = 215.30M ≈ Full's residual 215.28M. So **98.8 % of what Full still cannot
attribute is pre-profile history** (the one-time rollup back-fill, which raw logs cannot carry by
design) and **1.2 % is the identity-hint tier**. That is exactly the sentence the page now shows.

The profile cache currently holds 3 profiles, all for `token-monitoring` — the only project whose
profile-routed traffic exists so far. Both statements inlined all 3.

### Frontend

Built `assets/index-Dy8ndDe7.js` (contains the `en-US` formatter and the new precedence copy),
synced to the site bucket, CloudFront `E109P5BP3CW3XT` invalidated. Browser render not read this
round — `playwright-mcp` still fails to connect (`CONNECTION_CLOSED`), as in features 15/16.

## Rider: `ci-agent/bugfix_agent.py`

The qa job that surfaced these findings could not report them: `return 2` on "0 patches applied"
ran under the step's `bash -e` and aborted the step **before** its own `git add`, before the
unreachable "no applicable patch" branch, and before the Comment-on-PR / stall-detector / fuse
steps that own the red verdict — which is why PR #43 has a red `qa` and no comment. Fixed: return 0
(a result, not a tool failure); `extract_diff` accepts an unterminated fence (a max-token stop never
emits the closing one, so the advertised salvage was dead code — reproduced, then 7 edge cases
verified); prompt asks for the diff **before** the analysis and for no diff when the fix is not a
local edit. Tried and reverted: content-based file scoring, which mis-routed F-1101.

**None of this makes #43 green on its own.** F-1101 needed an attribution tier that did not exist;
a diff-emitting bot was right to refuse. Only this chain closes it.

## Known limits (stated on the page)

- The admin identity hint and the one-time historical attribution are rollup state with no raw-log
  field; Full will always show a larger `untagged` share than Fast by exactly those two tiers.
- A broken profile cache degrades silently to today's behaviour (one warning line). Correct trade
  against failing the page; the warning names the disabled tier so the log is diagnostic.
