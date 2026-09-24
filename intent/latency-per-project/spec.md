# Spec: latency per project

- **Intent:** ./intent.md
- **Author:** Claude (AI agent)
- **Accepted-by:** Tim WU
- **Status:** signed-off

## Behaviour

### 1. Ingestion extracts one key and drops the body
`parseLogFile` sets `record.latency = latencyOf(record)` and deletes `output.outputBodyJson`.
`latencyOf` reads `amazon-bedrock-invocationMetrics` from the last chunk (streaming) or the object
(non-streaming); returns `{ e2eMs, ttfbMs? }` or **null** when absent or non-numeric. Null is
"unknown" and folds into nothing — never into zero.

### 2. Rollups carry additive latency stats
`LatencyStats = { latencyCount, latencySumMs, latencyBuckets[10], ttfbCount, ttfbSumMs, ttfbBuckets[10] }`
with fixed upper edges 250 ms · 500 ms · 1 s · 2 s · 4 s · 8 s · 16 s · 32 s · 64 s and an open top
bucket. First-byte is a separate population (streaming calls only) and is never added to e2e. All
three aggregates (hourly usage, per-project, per-project-day) fold and merge it; all four `ADD`
writers persist it as flat numeric attributes `latencyCount/latencySumMs/latB<i>` and
`ttfbCount/ttfbSumMs/ttfbB<i>`, writing only the buckets a batch touched.

### 3. Backfill is guarded and visible
`backend/scripts/backfill-latency.ts` ADDs latency-only attributes for objects with
`lastModified ≤ BACKFILL_UNTIL` (required: the deploy time of the latency-aware aggregator — later
objects already carry latency). Dry run by default. Per-object marker `SYSTEM#BACKFILL#latency/<key>`
is claimed with `attribute_not_exists` before the ADDs and set `done` after; a re-run skips done keys
and **reports** claimed-but-unfinished ones instead of re-adding. Token counters are never touched.

### 4. API — `GET /v1/latency` gains `projects`
Same window (1|7|30). Reads the tenant's PROJDAY items over `projdayRange` (the 30-bucket one),
merges per project, returns rows `{ projectId, name, e2e, ttft }` where each figure is
`{ samples, meanMs, p50, p95, estimated: true, openEnded }`, sorted by e2e p95 desc; plus
`coverage { invocations, withLatency, pct }` and two notes: what share of calls carry a sample, and
that percentiles are bucket estimates. `LatencyFn` gains read grants on the tenants and aggregates
tables; the header states why the old "no table access" stance changed.

### 5. Page — "By project" panel on `/latency`
Below "By model": project · calls with latency · TTFB p50/p95 (— when no streaming calls) · E2E
mean/p50/p95. An `openEnded` row carries a `lower bound` badge and its p95 reads `≥ …`. The panel
description repeats the coverage note; the estimate note sits under the table. Empty state says why
a project can have no sample (pre-rollout rollups) and that the backfill supplies them.

## Out of scope
Athena parity; any new CloudWatch query; any change to the fleet section's numbers.
