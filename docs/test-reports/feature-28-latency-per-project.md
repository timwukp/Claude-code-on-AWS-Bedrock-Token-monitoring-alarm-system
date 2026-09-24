# Feature 28 — Latency per project (invocation-log rollups; bucket estimates beside exact fleet figures)

- **Chain:** `intent/latency-per-project/` · **Branch:** `feat/latency-per-project` off `main@e47da9b` (post-#59) · **PR:** #61
- **Origin:** ROADMAP row 13 was 🟡 because `/latency` was fleet-only — CloudWatch carries no project dimension.
- **Date:** 2026-09-24
- **Verdict:** PASS on gates and unit tests; live section filled after the deploys below.

## What this report has to say plainly
- **The numbers are estimates and say so.** Per-project p50/p95 are read from ten fixed-edge buckets
  (250 ms … 64 s, open top) by linear interpolation. They are exact only to the bucket's span; a rank in the
  open top bucket returns 64 s as a **lower bound** (`openEnded`, shown as `≥`). The fleet CloudWatch
  percentiles above the table are exact and are the reference. `estimated: true` is on every figure.
- **Coverage is partial and stated.** Only calls logged with a response body carry the metrics; rollups
  written before this build carry none until the backfill runs. The payload gives `withLatency / invocations`.
- **First-byte is a subset population.** Streaming calls only; its count is reported beside e2e and never added.
- **Built offline, cut after #57.** Under the owner's no-parallel-chains rule the code was written and
  gate-tested on `91bb02a` while feature-27 was in flight, then re-staged on `fe15d14` and again on `e47da9b` as #57 and #59 landed. The only shared
  file was `client.ts` (re-applied on top of #57's version); every other file was untouched by main.

## Scope
| File | Change |
|---|---|
| `backend/lambdas/ingestion/parse.ts` | `latencyOf`, `LatencySample`, `LatencyStats` + buckets, `foldLatency` / `mergeLatency` / `percentileFromBuckets`; `parseLogFile` extracts then **deletes** `outputBodyJson`; all 3 aggregates fold latency |
| `backend/lambdas/ingestion/latency-ddb.ts` | flat-attribute codec (`latencyAddClause`, `latencyFromItem`, `latencyOnlyAdd`) so the existing `ADD` writers work on absent items |
| `backend/lambdas/ingestion/aggregator.ts` | 3 merges + all 4 `ADD` writers carry latency |
| `backend/scripts/backfill-latency.ts` | guarded backfill: dry-run default, `BACKFILL_UNTIL` required, per-object claim/done markers |
| `backend/lambdas/api/latency-projects.ts` | `buildProjectLatencyRows`, `latencyCoverage` (pure) |
| `backend/lambdas/api/latency.ts` | tenant-scoped PROJDAY read; `projects` section; header + `scopeNote` rewritten |
| `infra/lib/stacks/api-stack.ts` | `LatencyFn` gains read on tenants + aggregates (reason in comment); no routes |
| `frontend/src/api/client.ts` · `LatencyPage.tsx` | types; "By project" panel with `lower bound` badge and `≥` |
| `docs/ROADMAP.md` row 13 | per-project measured; 🟡 remains only for Athena parity |

## Evidence the data exists (read, not assumed)
Real log object `…/2026/09/23/03/20260923T035942669Z_….json.gz`: 1 record, streaming body of 3 chunks,
metrics in the **last** chunk: `invocationLatency: 8019`, `firstByteLatency: 4180`, alongside the token counts.
Body size 8.9 KB for that single record — the reason for extract-then-discard.

## Gates
| Gate | Result |
|---|---|
| Backend `jest` | see below (offline tree: 254 → 286, 32 new) |
| Backend `tsc --noEmit`; `backfill-latency.ts` standalone tsc | PASS |
| Frontend `tsc --noEmit` / `vite build` | PASS |
| `cdk synth --context env=ci` | PASS — 10 stacks |
| `sdlc_ci_gate.py --require-active --base-sha fe15d14…` | see below |

## Unit tests (32 new)
`parse-latency.test.ts` (20): real-record shape; non-streaming object; null when absent / non-numeric /
negative / empty array; non-numeric first-byte dropped, e2e kept; extract-then-discard leaves `output`
without the body; bucket edges closed on the upper side, open top; separate populations; additive merge;
percentile interpolation inside a bucket, cumulative walk across buckets, open-ended lower edge; all three
aggregates fold once, de-duped by `requestId`, and treat a body-less record as unknown not zero.
`latency-ddb.test.ts` (7): empty → no clause; touched buckets only; first-byte only when present;
placeholders disjoint from the writers'; round-trip; **ADD twice == merge**; latency-only ADD.
`latency-projects.test.ts` (5): merge across days/models; sort by p95, drop sample-less projects; open-ended
flag; name fallback; coverage share.

## Deploy + live (2026-09-24, all under the owner's explicit authorisation)
| Step | Result |
|---|---|
| `cdk diff` / `deploy Tums-dev-Etl` | code-only (`AggregatorFn` S3Key); deployed 04:39–04:41Z. **`BACKFILL_UNTIL` = the pre-deploy aggregator watermark `2026-09-24T04:36:27Z`** — exact, not a wall-clock guess |
| `cdk diff` / `deploy Tums-dev-Api` | `LatencyFn` code + its policy (read on aggregates + tenants tables, `kms:Decrypt` on the Data key); no routes. Waited for the peer's OverviewFn deploy on the same stack to finish first |
| `LatencyFn` pre-backfill | 200; `projects.coverage = 0 / 8981 (0%)`, `rows: []` — honest empty, not fake zero |
| `backfill-latency.ts --apply` | **258,153 objects** (not the ~2,300 first estimated — a truncated CLI count), CONCURRENCY=24, 3 h 43 min on a phone hotspot. **71,132 objects with latency → 319,816 rollup ADDs, 121,141 samples.** 2 fetch aborts, both `…/data/<uuid>_input.json.gz` (S3-offloaded input bodies, not log records — now skipped by the listing). **0 stuck markers** (71,132 claimed, 71,132 done). Table is on-demand; the live aggregator was never blocked |
| Second `deploy Tums-dev-Api` | `LatencyFn` code only (reader fix below); 32 s |
| `LatencyFn` post-backfill, 7 d | 200; fleet e2e p50 4.34 s / p95 26.5 s (n 16,289), TTFT p50 2.27 s (n 11,633); **projects coverage 5,985 / 9,274 (65%)**; Token Usage Monitoring n 2,727 mean 10.7 s p50 7.6 s p95 31.0 s, TTFB p50 3.2 s; `untagged` n 3,258 p50 6.4 s p95 30.8 s |
| `LatencyFn` post-backfill, 30 d | 200; coverage 14,580 / 24,891 (59%); `untagged` n 10,309, Token Usage Monitoring n 4,271 |

### What the live data taught, and what was fixed because of it
1. **Bare rows.** The backfill's latency-only `ADD` onto a `(day, untagged, model)` key that had no item created **78 items with no `projectId`/`day`/`modelId`, holding 54,070 samples (45% of the backfill)**. Cause: feature-13's one-time `HOUR_PROJECT_MAP` had moved those days' *tokens* from `untagged` to projects, so no `untagged` row existed; the latency backfill attributes by the record's own signals and cannot replay that treatment. The reader then skipped keyless items, hiding the samples. Fixed three ways: the reader treats a missing `projectId` as `untagged` (as `dora.ts` does); the backfill's keyed writes now `SET … if_not_exists` the identifying attributes so a bare row can never be created again (`latencyOnlyAddWithKeys`, tested); and the 78 rows were repaired with the same `SET` (no counters touched; owner-authorised). Only the feature-13 marker item remains keyless, by design.
2. **Why not move that latency onto the projects?** Checked: only 32 rows / 2,550 samples (2%) have exactly one candidate project for their `(day, model)`; 46 rows / 51,520 samples have several. A second attribution rule to rescue 2% is not worth the explanation it needs. All of it stays `untagged`, and the code comment says why.
3. **Projects that show tokens but no latency in the window** (`proj-alpha`, `llmops-agentic-system`, `ai-native-sdlc`, …) exist in PROJDAY **only through that historical treatment**; on live days the aggregator itself files their calls under `untagged` (no AIP tag, no `requestMetadata`). So "0 latency samples" for them is the same fact as (1), not a gap in the backfill.
4. **Coverage is a property of the calls, not the pipeline.** On live days `us.anthropic.claude-sonnet-4-6` and `claude-opus-5-5` rows carry **0 samples** (e.g. 106 invocations, 0 with latency) — those calls log no inline response body, so Bedrock emits no `invocationMetrics` for them. That is most of the 41% without a sample. The page states the share; whether to enable body logging for those callers is an owner decision, not a code change.

### Hand-check
`Token Usage Monitoring`, 7 d: mean 10,746 ms over 2,727 samples; p50 reported 7,598 ms. The 4 s–8 s bucket is the one that holds rank 1,364, and 7,598 lies inside it — consistent with a right-skewed distribution whose mean (10.7 s) sits above its median, and with the fleet p50 (4.3 s) being pulled down by the shorter non-project calls. Estimate semantics hold: the figure is inside its bucket, labelled `estimated`, and not `openEnded`.
