# Spec: price prompt-cache writes

- **Intent:** ./intent.md
- **Author:** Claude (AI agent)
- **Accepted-by:** Tim WU
- **Status:** shipped

## Behaviour

### 1. Rate card — `backend/lambdas/api/cost-calc.ts`
- `ModelRate` gains `cacheWrite5mPerToken` and `cacheWrite1hPerToken`. Rows are built by `rate()`, which defaults them
  to `inPerToken × CACHE_WRITE_5M_MULT (1.25)` and `× CACHE_WRITE_1H_MULT (2)`, rounded to 12 decimals so derived
  rates render as exact decimals in Athena SQL. Rows may override: `gpt-5.6-sol` carries 1.25× on both columns (one
  30-minute TTL, Bedrock prompt-caching guide); `gpt-5` and `nova-micro` set both to 0 (implicit caching, no published
  write fee). New row `nova-micro` (0.035 / 0.14 / 0.00875 per MTok).
- `TokenCounts` gains `cacheWriteTokens`, `cacheWrite5mTokens`, `cacheWrite1hTokens`. Unknown-TTL tokens =
  `max(0, total − 5m − 1h)`.
- `ModelCost` gains `cacheWriteTokens`, `cacheWriteUnknownTtlTokens`, `cacheReadUsd`, `cacheWriteUsd`,
  `estimatedUsdUpperBound` (unknown at the 1-hour rate) and `cacheNetUsd` (= `cacheSavingsUsd` − the write premium over
  plain input). `estimatedUsd` now includes `cacheWriteUsd` with unknown at the 5-minute rate.
- `CostSummary` gains `totalEstimatedUsdUpperBound`, `totalCacheReadUsd`, `totalCacheWriteUsd`, `totalCacheNetUsd`; `summarizeCosts` merges
  the three counters and keeps a row whose only usage is cache writes.
- `cacheWriteOf(item)` reads the three counters off a rollup item, absent → 0.

### 2. Ingestion — `backend/lambdas/ingestion/parse.ts`, `aggregator.ts`
- `cacheWriteTtlOf(record)` returns `{m5, h1}` from `usage.cache_creation` (object body, or first chunk's
  `message.usage`) or Converse `usage.cacheDetails[]`, ONLY when `m5 + h1 === cacheWriteInputTokenCount`; `{0,0}`
  when the record wrote nothing; null (unknown) otherwise. `parseLogFile` stores it on `record.cacheWriteTtl` before
  deleting the body.
- `UsageAggregate`, `ProjectAggregate`, `ProjectDayAggregate` carry `cacheWriteTokens`, `cacheWrite5mTokens`,
  `cacheWrite1hTokens` (`CacheWriteCounters`); `foldCacheWrite` / `mergeCacheWrite` maintain them.
- All four writers ADD the three counters (shared `CW_CLAUSE`). `priceRecordUsd` and `detectRunaways` take the counters.
- `setWatermark` runs on every aggregator run and writes `lastRunAt` (ISO).
- Attribution: an untagged profile with a known model rewrites `effectiveModelId` and lets the project fall through to
  requestMetadata → identity hint → untagged. `loadAttributionMaps` maps every profile that is tagged OR resolves a
  model (`profileResolvesModel`); `resolveUnseenProfiles` treats only TAGGED profiles as known.

### 3. Backfill — `backend/scripts/backfill-cache-write.ts`, `lambdas/ingestion/cache-write-ddb.ts`
- Same safety as `backfill-latency.ts`: `BACKFILL_UNTIL` required, dry run by default, per-object marker
  `SYSTEM#BACKFILL#cachewrite` claimed with `attribute_not_exists` and flipped to `done`, stuck claims reported not
  re-added, concurrency pool. Objects with no cache writes get no marker.
- USAGE receives only the TTL split (it stored the total all along); MODEL / PROJECT / PROJDAY receive all three, with
  `if_not_exists` on their identifying attributes. The dry run prints the token total for comparison with Athena.
- `repair-projday-day.ts` `COUNTERS` includes the three.
- `verify-cache-write-backfill.ts` (read-only): per tenant, Σ `cacheWriteTokens` on MODEL, PROJECT and PROJDAY must equal
  USAGE's; on every item `5m + 1h ≤ total`; every `SYSTEM#BACKFILL#cachewrite` marker must be `done`. Exit 1 otherwise.
- `reconcile-cache-write.ts`: truth for every rollup item from ALL raw objects (watermark-raced), compared with stored;
  positive deltas ADDed with `--apply`; negative deltas reported and refused unless `--correct-over-counts` (the one
  established cause: an `ADD` retried by the SDK after a lost response on a flaky link). Idempotent: a re-run must
  show all-zero deltas.

### 4. API read paths
- Every PROJDAY/MODEL/PROJECT mapper spreads `cacheWriteOf(item)` (`costs.ts`, `projects.ts`, `overview.ts`, `roi.ts`,
  `dora.ts`); `project-calc.ts` `ProjdayItem` carries the three fields; `roi-calc.ts`, `project-calc.ts`,
  `overview-calc.ts` pass them to `computeModelCost`; `OverviewModelRow` gains `cacheWriteTokens`, `cacheReadUsd`,
  `cacheWriteUsd` (rounded to cents like `estimatedUsd`).
- Athena: `queries.ts` `rateCase` accepts `cacheWrite5mPerToken`; `byProject` and `projects.ts` `buildFullSql` add a
  `cacheWriteInputTokenCount` term at the 5-minute rate. `buildModelExpr` includes every profile whose model is known.
- Read-time profile resolution (qa F-PR69-004): `profileModelMap()` (registry) maps every cached profile ARN whose
  model is known to that model; `costs`, `projects` (fast path + model totals), `overview`, `roi` and `dora` apply it to
  each rollup row's `modelId` before pricing, so rows written under an opaque profile ARN before feature-36 price and
  merge as their model. Unreadable cache → rows keep their stored id (never a failure). `CostsFn` gains the tenants-table
  read grant the other four already hold.
- `/v1/overview` returns `rollupsLastRunAt` (from `SYSTEM#WATERMARK.lastRunAt`, null until the new build has run)
  beside `rollupsAsOf`. `/v1/usage` points gain `cacheWrite5mTokens`, `cacheWrite1hTokens`.

### 5. Frontend
- `client.ts` types. `CostsPage.tsx`: a Cache-write token column and two dollar columns, Cache-read (USD) and
  Cache-write (USD) — the bill's two cache lines, already inside Est. cost — all sortable, "—" on an API build that
  lacks them; and a pricing note under the table that names the four priced kinds, the TTL rule, and the open
  standard-route premium ("lower bound").

### Acceptance
- Unit: per-row 5 m / 1 h rates vs the Price List; unknown-TTL fallback and bound; cache-write-only rows kept;
  `cacheNetUsd` sign; TTL lift on stream / InvokeModel / Converse / body-less / mismatched-sum shapes; aggregates and
  runaway guard carry the counters; backfill ADD expressions; Athena SQL carries the term with exact decimals;
  untagged-profile fall-through. Every guard mutation-checked.
- Before deploy: new card on Athena by-model vs Cost Explorer cache-write lines, Jun 4 → Oct 5, per model within 0.1%.
- After deploy and backfill: MODEL `cacheWriteTokens` Σ = USAGE Σ per tenant; `/v1/costs` all-time ≈ $25.5k for the
  largest tenant; `/v1/overview.rollupsLastRunAt` present; the three profiles price > $0.

## Out of scope
See intent non-goals: route ×1.1; caching-as-discount copy and `help-content.ts`; guards and drift script; Glue DDL.
