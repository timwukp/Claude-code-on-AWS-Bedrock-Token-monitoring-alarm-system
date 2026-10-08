# Feature 36 — prompt-cache writes are priced

- **Chain:** `intent/cache-write-pricing/` · **Branch:** `feat/cache-write-pricing` off `main@ca0ba29` (post-#68) · **PR:** #69
- **Origin:** the feature-34 report's "known limit" (the card prices no cache writes), the deep-research pass of
  2026-10-05 (`docs/research-cache-write-pricing.md`), qa F-PR68-001 (freshness copy) and F-PR68-002 (three $0 profiles).
- **Date:** 2026-10-06
- **Verdict:** PASS on gates, bill reconciliation (−0.00%), live invocation and the served bundle; the backfill is exact
  (every rollup equals USAGE, re-check all-zero) after a reconcile that also found and corrected five SDK-retry
  double-counts. qa's browser run is left to the PR.

## What this report has to say plainly
- **Every dollar figure on every page moves, upward, by a lot.** Cost is computed from stored tokens at read time;
  the largest tenant's all-time total goes from $14,408 to about $25,540 (+77%). This is a correction, not a change
  in spend: the bill's largest token line (cache write, 37.0% of token spend Jun–Oct) was priced at $0.
- **The correction is checked against the bill, not against the rate card alone.** Inside the window both sources
  cover (2026-06-04 → 10-05), the new card reproduces Cost Explorer's cache-write lines to −0.00% in total and within
  0.04% per model. The earlier "unexplained" residuals were June 1–3 spend before logging began (2026-06-03T06:54Z).
- **One line stays open, and the page says so:** the standard-route premium (×1.1 on `us.`/geo/profile calls) is a
  separate chain; until it lands the figures are a lower bound, about 9% under the bill-equivalent.
- **Two card rows changed during validation,** in the direction the bill dictated: OpenAI-model cache writes are $0
  (no Cost Explorer line for them), and Amazon Nova Micro was added (three profiles had been pricing at $0).

## Scope
| File | Change |
|---|---|
| `backend/lambdas/api/cost-calc.ts` / `.test.ts` | `cacheWrite5mPerToken` / `cacheWrite1hPerToken` on every row via `rate()`; `cacheWriteOf`; `ModelCost` gains `cacheWriteTokens`, `cacheWriteUnknownTtlTokens`, `cacheWriteUsd`, `estimatedUsdUpperBound`, `cacheReadUsd`, `cacheNetUsd`; totals; `nova-micro` row; gpt rows charge $0 for writes; 16 new cases |
| `backend/lambdas/ingestion/parse.ts` / `parse-cache-write.test.ts` (new) / `parse-attribution.test.ts` | `cacheWriteTtlOf` (stream first chunk / InvokeModel object / Converse `cacheDetails`; null unless the split sums to the record's count); `CacheWriteCounters`, `foldCacheWrite`, `mergeCacheWrite` on all three aggregates; runaway guard takes the counters; untagged-profile fall-through in `deriveProject`; 15 + 4 cases |
| `backend/lambdas/ingestion/aggregator.ts` | `CW_CLAUSE` ADDs the three counters on all four writers; `priceRecordUsd` prices writes; `setWatermark` on every run with `lastRunAt`; untagged profiles mapped for their model, tagged ones alone count as "known" |
| `backend/lambdas/ingestion/cache-write-ddb.ts` / `.test.ts` (new) | the backfill's add-only expression (`if_not_exists` keys; USAGE gets the split only) |
| `backend/scripts/backfill-cache-write.ts` (new) · `repair-projday-day.ts` | guarded backfill in the latency-backfill style; `COUNTERS` include the three |
| `backend/lambdas/shared/project-registry.ts` / `.test.ts` | `profileResolvesModel`; `loadAttributionMaps` maps tagged OR model-resolving profiles |
| `backend/lambdas/api/queries.ts` / `.test.ts` · `projects.ts` / `projects-sql.test.ts` | Athena terms for `cacheWriteInputTokenCount` at the 5-minute rate; `rateCase` field; `buildModelExpr` includes untagged profiles; derived rates render as exact decimals |
| `backend/lambdas/api/costs.ts`, `overview.ts`, `roi.ts`, `dora.ts`, `usage.ts`, `project-calc.ts` (+test), `roi-calc.ts` (+test), `overview-calc.ts` (+test) | mappers spread `cacheWriteOf`; `ProjdayItem` carries the three; `/v1/overview.rollupsLastRunAt`; `OverviewModelRow.cacheWriteTokens` |
| `frontend/src/api/client.ts`, `frontend/src/pages/CostsPage.tsx` | types; Cache-write token column and Cache-read (USD) / Cache-write (USD) columns (sortable, "—" on an older API build); pricing note under the table |

## Gates
| Gate | Result |
|---|---|
| Backend `jest` / `tsc --noEmit` | PASS — 334/334, 27 suites (was 287/25 at #67) |
| Frontend `tsc --noEmit` / `vite build` | PASS |
| `cdk synth -c env=ci` | PASS — 10 stacks (infra untouched) |
| `sdlc_ci_gate.py --require-active` | PASS — 29 source files, all named in the plan; approval bound to `ca0ba29` |

### Mutations (each restored after the run)
| Mutation | Tests failing |
|---|---|
| drop the cache-write term from `estimatedUsd` | 3 |
| unknown-TTL bucket forced to 0 | 3 |
| zero-row filter ignores cache write | 1 |
| `cacheNetUsd` subtracts the full write cost, not the premium | 3 |
| 1-hour rate = 5-minute rate | 14 |
| drop the `m5 + h1 === total` check in `cacheWriteTtlOf` | 1 |
| drop the 1-hour fold | 1 |
| read the split from the LAST chunk instead of the first | 6 |
| `parseLogFile` skips the lift | 5 |
| `deriveProject` returns an untagged profile outright (old behaviour) | 2 |

## Rates — AWS Price List, read 2026-10-05 and independently re-read 2026-10-06 (USD per MTok)
Cache write is 1.25 × input (5-minute TTL) and 2 × input (1-hour) on every Claude row; e.g. `fable-5-1` 12.50 / 20.00,
`opus-5-5` 5.00 / 8.00, `sonnet-4-6` 3.75 / 6.00, `haiku` 1.25 / 2.00. `nova-micro` 0.035 / 0.14 / 0.00875 / 0 / 0
(`AmazonBedrock`, `USE1-NovaMicro-*`). `gpt-*` cache write 0 / 0 (no Cost Explorer line).

## Reconciliation against the bill — BEFORE any deploy
Athena per model × route (28.96 GB, ≈ $0.14) priced with the new card at the 5-minute rate, × 1.0 (`global.`) or × 1.1
(standard), versus Cost Explorer `*cache-write*` usage types, 2026-06-04 → 10-05 (logs begin 06-03T06:54Z):

| Model (route) | Estimate × route | Cost Explorer | Δ |
|---|---|---|---|
| fable-5 (standard) | $7,098.56 | $7,099.64 | −0.02% |
| opus-5 (standard) | $2,362.64 | $2,363.50 | −0.04% |
| fable-5-1 (standard) | $1,427.45 | $1,427.55 | −0.01% |
| sonnet-4-6 (standard) | $881.57 | $881.56 | 0.00% |
| opus-4-8 (standard) | $375.22 | $375.22 | 0.00% |
| opus-5-5 (standard) | $63.44 | $63.44 | 0.00% |
| haiku-4-5 (standard) | $5.05 | $5.05 | 0.00% |
| opus-4-6 | $0.00 | $0.52 | not in the logs |
| gpt-5.6-sol | $0.00 (was $2.03 at 1.25×) | $0.00 | not billed → row set to 0 |
| **Total** | **$12,216.11** | **$12,216.63** | **−0.00%** |

Cost Explorer paginates; all pages were read (200 lines, 94 usage types, $33,515 total). No usage type names a 1-hour
TTL, and the 5-minute hypothesis reconciles, so this account's writes are 5-minute writes.

Repricing of the stored tokens, no route factor (what the pages will show), 2026-06-01 → 10-05 by Athena:

| Tenant | Before | After | of which cache write | Upper bound (unknown TTL at 1 h) |
|---|---|---|---|---|
| largest (IAM user) | $14,408.42 | $25,540.37 | $11,131.96 | $32,218.44 |
| all tenants | $19,421.97 | $30,554.63 | $11,132.66 | — |

Every other tenant has 0 cache-write tokens, so only the largest moves.

## Backfill dry run — BEFORE any deploy (reads only, cut-off 2026-10-06T06:00Z, concurrency 24, 59 min)
| Figure | Value |
|---|---|
| Log objects before the cut-off | 108,807 (92,502 with cache writes, 16,304 without → no marker) |
| Item ADDs it would perform | 466,136 |
| Cache-write tokens | **1,255,288,871** — 1,210,835,074 known 5-minute (96.5%), 0 known 1-hour, 44,453,797 TTL unknown (3.5%) |
| Athena `SUM(cacheWriteInputTokenCount)`, same cut-off | 1,255,306,447 |
| Difference | 17,576 tokens (0.0014%): one object's GET aborted (`2026/08/20/13/…d3598dbd…`, reported, no marker, so a re-run picks it up) plus `lastModified`-vs-`timestamp` skew at the cut-off |

The TTL lift works on real bodies at scale: 96.5% of all historical cache-write tokens get a known TTL, all of it
5-minute, consistent with the bill. The 3.5% unknown is records whose body was not logged.

`cdk diff Tums-dev-Etl Tums-dev-Api -c env=dev`: Lambda **code only** — `AggregatorFn` and the nine API functions
(`UsageFn`, `CostsFn`, `QueriesFn`, `ProjectsFn`, `DoraFn`, `ProjectRegistryFn`, `RoiFn`, `LatencyFn`, `OverviewFn`); no
IAM, environment or other resource changes.

## Backfill — applied (2026-10-06/08), with what went wrong and how it was made exact
`BACKFILL_UNTIL = 2026-10-06T07:19:00Z` — the last object the OLD aggregator had folded (read from the watermark after
the owner's Etl deploy at 07:36Z and before the new build's first run at 07:51Z), so the two builds overlap on no object.

| Pass | Host | Result |
|---|---|---|
| 1 `--apply` | owner's laptop | 51,220 objects, 250,410 ADDs, 653.6M tokens — then the laptop lost DNS: 50,229 objects failed before their GET (no marker, safe to re-run), **44 left `claimed` mid-ADD** |
| 2 `--apply` (resume) | laptop | 52,450 of 57,563 before being stopped to move off the laptop (owner rule, 2026-10-07): **50 more `claimed`** |
| 3 `--apply` (resume) | EC2 runner | remaining 19,480 objects in **4 min**; second pass 0 new ADDs; `verify`: every tenant exact **except the largest**, short 1.58M / 1.97M / 2.06M tokens on MODEL / PROJECT / PROJDAY (0.16%) |
| 4 `reconcile` dry | EC2 | truth from all 109,021 objects vs stored, 11,282 items: 11,252 exact, **30 short, 5 OVER** → refused |
| 5 `reconcile --apply --correct-over-counts` | EC2 | 35 items corrected (30 +, 5 −); aggregator ran mid-compare, 12 new objects folded before writing; **re-check: 11,285 / 11,285 exact**; `verify`: gap 0 on every tenant, no item with split > total, 94 stale markers closed as `reconciled` |

**The five over-counts are a finding, not noise.** Each was one object's worth, on the two days the laptop's link was
flaky, and one USAGE hour had a 5-minute split larger than its own total — which a single pass cannot write. Cause:
the AWS SDK retries an `UpdateItem` whose response was lost, and `ADD` is not idempotent, so the retry landed twice.
The backfill's own guard (marker before ADDs) cannot see this; `reconcile-cache-write.ts` can, and it refuses to
subtract until the cause is named — the `--correct-over-counts` flag documents it. The same mechanism is now a drift
check: on a healthy table a dry run reports all-zero deltas.

EC2 runner (owner rule: long jobs off the laptop): t3.medium, no inbound rule, SSM only, IMDSv2, encrypted gp3, role
scoped to the two tables, the two buckets' job prefix and the project CMK; terminated after the run. All run logs:
`s3://token-monitoring-curated-dev-<ACCT>/jobs/feature-36-cache-write-backfill/runs/`. Three gotchas cost time and are
recorded for the next job: no NAT in the default VPC (needs a public IP + zero-inbound SG), the CMK grant, and SSM Quick
Setup swapping the instance profile after a stop/start.

Final state (verify, 2026-10-08 05:30Z): largest tenant USAGE = MODEL = PROJECT = PROJDAY = **1,262,456,787** cache-write
tokens, 1,218,012,656 known 5-minute (96.5%), 0 known 1-hour, 44.4M TTL unknown (3.5%, body not logged); every other
tenant exact; 92,530 markers done, 0 claimed.

## Live — dev, `Tums-dev-Etl` + `Tums-dev-Api` deployed by the owner (10-06 07:36Z and 10-08 05:36Z, code-only)
Deployed Lambdas invoked directly with an API-Gateway event carrying the tenant's `custom:tenantId` and `admin` claims.

| Check | Result |
|---|---|
| New aggregator's first run | `lastRunAt` written; the 07:00Z hour's USAGE/MODEL/PROJECT/PROJDAY all carry `cacheWrite5mTokens` = 345,790, `1h` = 0 |
| `/v1/costs` all-time (largest tenant) | **$25,721.95** (was $14,408.42); upper bound $25,958.04; cache read $10,592.51; **cache write $11,272.70**; 29 models |
| per model cache write | fable-5 $6,453.24 · opus-5 $2,147.38 · sonnet-4-6 $800.88 · fable-5-1 $1,275.09 · opus-4-8 $368.20 — fable-5 and opus-4-8 equal the pre-deploy Athena figures to the cent; the others carry 10-06 → 10-08 traffic |
| unknown-TTL share | 44,444,131 of 1,264,385,187 tokens (3.5%) |
| `/v1/overview?window=7` | 200; `rollupsAsOf` 2026-10-08T05:38:56Z, **`rollupsLastRunAt` 2026-10-08T05:51:30Z**; byModel rows carry `cacheReadUsd` / `cacheWriteUsd` / `cacheWriteTokens` |
| Nova profiles (qa F-PR68-002) | new traffic resolves to `amazon.nova-micro-v1:0` and prices; the historical MODEL row keyed by one profile ARN holds 580 in / 80 out tokens and stays at $0.00 (immaterial, stated) |

## Served bundle (CloudFront, invalidation completed; `assets/index-BsMPCYw_.js`)
Present: "Cache-write (USD)", "Cache-read (USD)", "standard-route premium", "treat these figures as a lower bound",
`cacheWriteUsd`. Browser render not walked by hand this round (left to qa's browser run on the PR, as in #67).

## Known limits, stated rather than fixed
- Standard-route premium (×1.1) not applied — separate chain; the Cost page says "lower bound".
- Athena/Full cannot see the TTL; it assumes 5 minutes. The Fast path reads it per call.
- The TTL split is known only for records whose body was logged; the rest are "TTL unknown" and priced at 5 minutes
  with a 1-hour bound exposed.
- `cacheNetUsd` is emitted for the peer's `cache-cost-truth` chain, which owns the "Saved by prompt caching" copy;
  this chain does not reword it.
