# Spec: overview page and endpoint

- **Intent:** ./intent.md
- **Author:** Claude (AI agent)
- **Accepted-by:** Tim WU
- **Status:** signed-off

## Behaviour

### 1. `GET /v1/overview?window=7|30|90|mtd` (default 30)
Response (additive to the API surface):
```
{ tenantId, window: { kind, days, from, to, priorFrom, priorTo },
  spend: { currentUsd, priorUsd, deltaUsd, deltaPct|null, tokens, priorTokens, daily: [{ day, usd, tokens }] },
  byModel: [{ modelId, inputTokens, outputTokens, cacheReadTokens, invocations, estimatedUsd }],
  movers: [{ projectId, name|null, currentUsd, priorUsd, deltaUsd, deltaPct|null }],   // |deltaUsd| desc, top 8
  coverage: { firstDayWithData|null, partial }, rollupsAsOf|null }
```
- Windows: `7/30/90` = the last N calendar days ending today (UTC), prior = the N days before; `mtd`
  = 1st of month → today, prior = the same elapsed-day count of the previous month (clamped to its length).
- One PROJDAY range read (`priorFrom` … `to`), priced per (project, model, day) with `computeModelCost`
  and the shared rate card. `deltaPct` is null when the prior period is zero. `daily` is zero-filled
  for every day of the current window. `coverage.partial` is true when the earliest rollup day is after
  `priorFrom` (or there is no data).
- `rollupsAsOf` = the aggregator watermark, the page's "data as of".
- Pure arithmetic in `overview-calc.ts` with unit tests; handler in `overview.ts`; `OverviewFn` in
  `api-stack.ts` with read grants on the tenants (registry) and aggregates tables.

### 2. `/v1/governance` additive fields
`budget.billingDataAvailable` = `CalculatedSpend.ActualSpend.Amount != null`; `budget.forecastAvailable`
likewise. Existing numeric fields unchanged.

### 3. Frontend
- `lib/budget-status.ts`: `budgetState()` → `setup-required | no-billing-data | ok | forecast-over |
  over` with a status chip per state; older API builds without the flag infer availability from a
  positive amount.
- `pages/OverviewPage.tsx`: four `KpiTile`s as in the intent (Spend `goodDirection: 'down'`; Budget
  value = billed amount, definition names the limit; Anomalies filtered client-side by `detectedAt`;
  Deployment frequency = median `df.value` across `doraOverview` rows, `mtd` coerced to 30 with a note),
  a "What changed" panel (movers table with signed change and %, `—` when no prior spend), a data-as-of
  line, and `EmptyState`s for loading / error / no movers. Follows the global range.
- `main.tsx`: `/` → `OverviewPage`, `/usage` → `UsagePage` (both with `PAGE_META` entries and
  windows); `Layout.tsx`: an **Overview** group with the first nav item; `api/client.ts`: `overview()`
  and typed `GovernanceBudget`; `help-content.ts`: `overview.*` entries; `styles.css`: `.delta-up/.delta-down`.

## Out of scope
Cost/Projects windowing (next chain); any existing number; `format.ts`; Latency.
