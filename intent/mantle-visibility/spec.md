# Spec: Mantle visibility

- **Intent:** ./intent.md
- **Author:** Claude (AI agent)
- **Accepted-by:** Tim WU
- **Status:** shipped

## Behaviour
1. `backend/lambdas/ingestion/bill-parse.ts` — `parseUsageType` (current `<model>-mantle-<kind>[-1h][-global]-standard`
   and legacy `Claude4.6Sonnet-<kind>[-cross-region-global]` schemes, region prefix, unknown → kind `other`);
   `billLinesFrom(ResultsByTime)` drops only all-zero rows.
2. `backend/lambdas/ingestion/bill-collector.ts` — daily; `ce:GetCostAndUsage` DAILY, `UnblendedCost` + `UsageQuantity`,
   `GroupBy USAGE_TYPE`, SERVICE ∈ {"Amazon Bedrock Service","Amazon Bedrock"}, last `BILL_LOOKBACK_DAYS` (4) days, all
   pages; PutItem `BILL#DAILY` / `<day>#<usageType>`; `SYSTEM#BILL`/`collector` with `lastRunAt`.
3. `backend/lambdas/ingestion/aggregator.ts` — maintains `SYSTEM#TENANTS`/`all` (merged set of tenants seen) so readers can
   sum every tenant's PROJDAY rows without a scan.
4. `backend/lambdas/api/bill-calc.ts` — `billModelKey` (card key or normalized id), `buildBill(lines, logged, mantle,
   window, asOf)`: filters lines to the window, `daysBilled` = distinct billed days, logged estimate restricted to those
   days, `unloggedUsd = max(0, billed − logged)` with `overEstimated` when negative, totals, `loggedSharePct`;
   `mantleConsistent` (Model series Σ vs fleet within 1%).
5. `backend/lambdas/shared/logged-estimate.ts` — `computeLoggedByModelDay` (every tenant from `SYSTEM#TENANTS`, PROJDAY
   rows for the day range, profile-resolved, priced by `computeModelCost`, bounded concurrency) run by the COLLECTOR and
   stored as `LOGGED#DAILY`/`<day>#<modelKey>` (SET, idempotent); `readLoggedByModelDay` for the API.
   `backend/lambdas/api/bill-read.ts` — DDB readers for lines/asOf and the stored logged rows, `readMantle` (ListMetrics Model series; GetMetricData daily sums of
   Inferences / InferenceClientErrors / TotalInputTokens / TotalOutputTokens + fleet Inferences), `billBlockFor` (null
   until the collector has run; Mantle failures leave `mantle: null`).
6. `/v1/overview` → `bill` for the page window; `/v1/costs` → `bill` over every stored day; `/v1/latency` → `mantle`.
7. Infra: `BillCollectorFn` (Etl, 06:30 UTC daily, `ce:GetCostAndUsage` on `*`, aggregates read/write); `CostsFn` and
   `OverviewFn` gain `cloudwatch:GetMetricData` + `ListMetrics`.
8. Frontend: Cost page panel "Billed vs what the logs price" (per model: billed · logged estimate · not logged · Mantle
   counts; total with logged share; bill-through date; `overEstimated` chip); Overview spend tile appends the unlogged
   amount; Latency By-model table gains a `bedrock-mantle` row.

## Acceptance
- Unit: 13 real usage-type shapes parse; `billLinesFrom` keeps $0-but-used lines; `buildBill` day alignment, floor+flag,
  totals, empty window; `mantleConsistent`; mutations (day filter dropped, floor removed) each fail a test.
- Live after the owner's Etl + Api deploys and one manual collector run: `BILL#DAILY` rows for the last 4 days;
  `/v1/costs.bill.byModel` has opus-5-5 with `mantle.inferences` > 0 and `unloggedUsd` > 0; `/v1/latency.mantle` present;
  served bundle shows the panel. Cost: CE API ≈ $0.5/month.

## Out of scope
See intent non-goals; GPT rate rows / `unpricedModels` / role-prefix identity (chain A); copy polish (chain B).
