# Feature 18 — Model-hop latency (the chain drawn honestly, not drawn complete)

- **Chain:** `intent/latency-observability/` · base `main@c55ceb0` (post-#50; the chain's
  `Accepted-for`, and its merge base) · **PR:** TBD
- **Origin:** a customer evaluating this product said latency was their current focus and asked what
  other companies measure across cost, latency and feature parity. The research that answered it is
  `docs/research-latency-measurement.md`; this chain is the part of that answer we can actually
  evidence from our own telemetry.
- **Date:** 2026-09-18
- **Verdict:** PASS — gates below, and a live cross-check of the deployed Lambda's percentiles
  against CloudWatch itself, which is the part that matters here.

## The one thing this report has to say plainly

**Only two of the five hops in the request chain are measurable today, and the feature's whole
design problem was to draw the chain anyway without implying the rest are measured.** A diagram of a
five-hop pipeline invites the reader to believe five numbers exist. Four mitigations, all structural
rather than editorial:

| Mitigation | Where it lives |
|---|---|
| `hopModel()` is the single definition of the chain **and** of each hop's observability | `backend/lambdas/api/latency.ts` — not the page, so the claim ships with the data that backs it |
| A hop marked `unmeasured` may not carry a `metric` field | asserted in `latency.test.ts`; sizing a dark hop later means deleting a test |
| Unmeasured hops get fixed width, no number, and name the telemetry needed | rendered from `data.hops`, so the page cannot invent one |
| The derived segment is flagged `derived` in the payload and chipped on the card | percentile arithmetic is not valid arithmetic; the label is the only thing keeping it from being a fabrication |

The five hops and their status:

| Hop | Status | Source, or what it would take |
|---|---|---|
| Developer IDE / CLI | **unmeasured** | Claude Code OpenTelemetry export (`api_request` carries `duration_ms`, `total_retry_duration_ms`; per-request TTFT only in beta trace spans) |
| LLM gateway | **unmeasured** | LiteLLM Prometheus histograms; its `response_time` field is not the same measurement |
| Bedrock → model, time to first byte | **measured** | CloudWatch `TimeToFirstToken` |
| Bedrock → model, streaming generation | **measured (derived)** | `InvocationLatency − TimeToFirstToken` |
| Bedrock Guardrails | **unmeasured** | Converse `trace.guardrailProcessingLatency`; AWS does not state whether `latencyMs` already includes it |

Three of those five sit in the customer's own estate, not ours. Saying so is the feature — it is the
difference between a gap and a silent zero.

## What shipped

- **`backend/lambdas/api/latency.ts`** — `GET /v1/latency?window=1|7|30`. `GetMetricData` against
  `AWS/Bedrock` for `InvocationLatency` and `TimeToFirstToken`, asking CloudWatch for `p50`/`p95`/`p99`
  and `SampleCount` **directly** rather than recomputing percentiles from datapoints we fetched;
  `ListMetrics` enumerates the `ModelId` dimension for the per-model table (capped at 12 series). Pure
  exports: `hopModel()`, `deriveGeneration()`, `combineBuckets()`.
- **`infra/lib/stacks/api-stack.ts`** — `LatencyFn` (`NodejsFunction`, 512 MB / 20 s, modelled on
  `DoraFn`) and the `v1/latency` GET resource. IAM is `cloudwatch:GetMetricData` +
  `cloudwatch:ListMetrics` on `*` (neither action supports resource-level permissions) and **no table
  grant of any kind** — the endpoint reads no tenant data beyond checking the tenant claim.
- **`frontend/src/pages/LatencyPage.tsx`** — the chain diagram (SMIL `<animate>`, so no new CSS and no
  new dependency), window / percentile / model controls, the fleet KPI row, the by-model table sorted
  by p95, the "what we cannot see yet" panel, and a "Definitions & limitations" disclosure.
- **`client.ts` / `main.tsx` / `Layout.tsx`** — the API method and types, the route, and one nav entry
  in the **Delivery** group using the `timer` glyph already present in `Icon.tsx`.

### Two design decisions that are limits, not features

**1. Percentiles disclose whether they are exact.** CloudWatch computes each percentile inside its
own period bucket, and asking for a period equal to the whole window does **not** guarantee one
bucket back. `combineBuckets()` collapses multiple buckets to a sample-count-weighted mean and flags
the value `approximated`; an unflagged value is exact for the window. This is not a hypothetical —
see the live table below, where 7 days comes back exact and 30 days does not.

**2. The scope is the account, not the project.** CloudWatch publishes no tenant, project or user
dimension for these metrics. That is stated in the payload's `scopeNote` and in the page's
disclosure, and it is the reason the IAM policy needs no table grant. Per-project latency is a
different source entirely — `amazon-bedrock-invocationMetrics` inside the invocation logs — and it is
**not** built here; it needs count/sum/bucket fields threaded through three aggregate interfaces and
four `ADD` writers plus a guarded backfill, and the payload it lives in is the one that already OOMed
a 4 GB heap at ~70k objects, so it has to be extract-then-discard. Written up as future work, not
implied as present.

### What the page deliberately does not say

**Nothing links latency to developer productivity.** Three of the five research angles produced no
surviving evidence, including every candidate claim that response latency changes developer output or
satisfaction. So latency is reported as a service characteristic, the payload's `caveat` field says so
in as many words, and the page repeats it. Terseness and the absence of a target line are design
judgements here, not findings, and the report says that rather than dressing them up.

## Unit tests / gates

Run on a clean export of `main@c55ceb0` with only this change applied.

| Gate | Result |
|---|---|
| backend `jest` | **215 / 215**, 21 suites (`main` alone is 194 across 20; the new suite is the 21 cases) |
| backend `tsc --noEmit` | exit 0 |
| frontend `tsc --noEmit` | exit 0 |
| frontend `vite build` | succeeded — `index-ZX2Xqn9Y.js` |
| `cdk synth --context env=ci` | succeeded, all 10 stacks synthesized |
| `sdlc_ci_gate.py` | PASSED — every changed source file named in the plan, `Accepted-for` == merge base |
| leak scan | no 12-digit account ids, no ARNs, no key material, no customer names |

The 21 cases cover the three pure functions. `deriveGeneration`: subtraction against a measured
fixture, the streaming sample count rather than the end-to-end one, floor-at-zero when TTFT exceeds
E2E, per-percentile null isolation, all-null on an empty window, and `approximated` propagating from
either input. `combineBuckets`: one bucket stays exact and unflagged, several collapse to a weighted
mean and are flagged, zero-sample buckets are ignored rather than diluting the mean, an empty series
yields nulls. `hopModel`: chain order, exactly two measured hops and both inside Bedrock, a distinct
`metric` per measured hop, **no `metric` on any unmeasured hop**, `instrument` text on all three dark
hops, the LiteLLM `response_time` warning, and a fresh array per call.

## Live validation — deployed `Tums-dev-Api`, real CloudWatch data

`Tums-dev-Api` was deployed from a clean stage after `cdk diff` was read: the only IAM addition is
`cloudwatch:GetMetricData` + `cloudwatch:ListMetrics` on `*` for the new role, plus the standard
`AWSLambdaBasicExecutionRole` and X-Ray statements. Deploy completed in 73 s, 24 resources, no
security section beyond that. The same deploy also shipped already-merged `AnomaliesFn` (#50) and
`RoiFn` (#49) code, which is desirable — those Lambdas had been merged but never deployed.

There is no Cognito session in hand, so the deployed `LatencyFn` was invoked **directly** with an
API-Gateway event carrying real `custom:tenantId` / `admin` claims — same deployed code, same live
CloudWatch, only the token exchange skipped. This is the method features 15–17 used.

| Window | Status | E2E p50 / p95 / p99 | samples | `approximated` | models |
|---|---|---|---|---|---|
| 1 day | 200 | 3956 / 24052 / — ms | 10,318 | absent (exact) | 7 |
| 7 days | 200 | 4093 / 27531 / 59962 ms | 18,602 | absent (exact) | 10 |
| 30 days | 200 | 3991 / 33139 / — ms | 72,668 | **`true`** | 10 |
| 90 days | **400** | — | — | — | `window must be one of 1, 7, 30` |

TTFT at 7 days: p50 2224 / p95 8954 / p99 21983 ms over 12,390 samples — i.e. **67 % of invocations
were streaming**, and the page discloses that ratio at the number rather than letting the smaller
sample count look like a discrepancy.

**The `approximated` flag was observed, not merely unit-tested.** A 7-day window comes back as one
CloudWatch bucket and is unflagged; the 30-day window does not and is flagged. Had both been exact,
the flag would have proven nothing.

### Percentiles proven against CloudWatch, not assumed

The load-bearing check. A direct `get-metric-statistics --extended-statistics p50 p95 p99` over the
same 7-day window, one 604 800 s period:

| | Lambda | CloudWatch direct |
|---|---|---|
| p50 | 4093 | 4093.40 |
| p95 | 27531 | 27523.59 |
| p99 | 59962 | 59947.41 |
| SampleCount | 18,602 | 18,613 |

Agreement to rounding — CloudWatch's values are shown to two decimal places here rather than in full
precision, because a long decimal tail is an unbroken run of digits and the repository's pre-push
scan rejects any 12-digit run, account id or not. The 11-sample and ~8 ms gaps are the seconds that elapsed between the two
calls — a rolling window moved, which is itself the expected behaviour rather than an error. This is
what distinguishes "the Lambda returned plausible numbers" from "the Lambda's percentile handling is
correct".

### Auth path

A first pass of the window loop accidentally omitted the tenant claim and every window returned
**400 `Missing tenant claim on token — refusing cross-tenant access.`** Recorded because it is
evidence, not noise: the tenant guard runs **before** window validation, so the endpoint refuses an
unauthenticated caller rather than doing CloudWatch work for one. The table above is the re-run with
the claim present.

### Frontend

`vite build` → `index-ZX2Xqn9Y.js`, synced to the dev site bucket with `--delete`, CloudFront
`E109P5BP3CW3XT` invalidated (`I3XWUGA2FLV8C4YGDED0AYJVOD`). The **served** bundle was fetched back
from CloudFront and confirmed to be that hash, containing `Model-hop Latency`, `v1/latency`,
`/latency` and the window control's `24 hours` label.

Worth stating so a future reader does not read it as a miss: the **hop labels are absent from the
bundle by design**. `hopModel()` lives in the Lambda and the page renders `data.hops`, so
"Developer IDE / CLI" and "LLM gateway" are asserted on the API response (above) rather than in the
JavaScript. A bundle grep for them failing is the expected result of putting the claim with the data.

## Known gaps

- **No browser render check.** There is no Cognito session in hand — credential extraction from the
  transcript was denied earlier in this work and was not retried — so the evidence is Lambda-,
  HTTP- and bundle-level only. The same gap was stated in the feature-15 and feature-22 reports;
  it is a standing limitation of this environment, not a shortcut taken here.
- **Fleet scope only.** No per-project, per-user or per-tenant latency, and therefore no join to
  cost, DORA or ROI. Stated on the page and in `scopeNote`; the rollup work it needs is in the
  intent's non-goals.
- **The by-model table is capped at 12 `ModelId` series** from `ListMetrics`, with no pagination. A
  fleet using more models sees an incomplete table while the fleet row stays correct. Acceptable for
  a first cut; it needs pagination before it is a customer-facing promise. The live account returned
  10 series, so the cap was not exercised.
- **Athena / Full-view latency is not possible today.** The Glue column is
  `output struct<outputContentType:string,outputTokenCount:int>` — the invocation-metrics key is not
  mapped — and the table is created out-of-band rather than by CDK, so the fix is a DDL change this
  repo does not own.
- **The derived generation segment is arithmetic on percentiles**, which is not valid arithmetic. It
  ships flagged `derived` because the shape is useful. If that label is ever dropped, the number
  becomes a fabrication.

## Leak scan

`grep -nE '[0-9]{12}|AKIA|arn:aws'` over every file in this PR: no matches. No account id, no ARN,
no key material, no tenant principal and no customer name appears in this report or anywhere in this
chain; where an ARN shape is needed it is written with a placeholder account segment.
