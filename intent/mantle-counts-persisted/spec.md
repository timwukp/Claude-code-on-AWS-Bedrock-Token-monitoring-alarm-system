# Spec: Mantle counts persisted

- **Intent:** ./intent.md
- **Author:** Claude (AI agent)
- **Accepted-by:** Tim WU
- **Status:** signed-off

## Behaviour
1. `backend/lambdas/shared/mantle-metrics.ts` (new) — `listRecentMantleModels()`; pure `mantleModelsToQuery(listed, stored,
   billModels)` (union; bill models filtered to `<vendor>.<id>` shape and not containing `-mantle-`); `fetchMantleDaily(models,
   from, to)` → per-day rows (zero rows dropped) + per-day fleet; `storeMantleDaily` (PutItem, SET semantics) →
   `MANTLE#DAILY/<day>#<model>`, `MANTLE#FLEET/<day>`; `storedMantleModels()`; `readMantleDailyStored`; pure `foldMantle`;
   `readMantle(from, to)` = stored days + live tail after the last stored day, returns `storedThrough`.
2. `backend/lambdas/ingestion/bill-collector.ts` — after the bill and logged sides, computes and stores Mantle rows for
   `[start, lastDay]`; failures are logged and do not stop the dollar side; `SYSTEM#BILL.mantleRows`.
3. `backend/lambdas/api/bill-read.ts` — CloudWatch code removed; re-exports the shared `readMantle`; `billBlockFor` adds
   `mantleStoredThrough`. `backend/lambdas/api/latency.ts` imports the shared reader.
4. `backend/lambdas/ingestion/bill-parse.ts` — `BillKind` gains `cacheWrite30m`; regex accepts `-30m`.
   `backend/lambdas/api/bill-calc.ts` folds every `cacheWrite*` kind into `byKind.cacheWrite`.
5. `infra/lib/stacks/etl-stack.ts` — `BillCollectorFn` gains `cloudwatch:GetMetricData` + `cloudwatch:ListMetrics` (IAM).
6. Frontend — `BillBlock.mantleStoredThrough?`; Cost page: "unresolved" badge in the Mantle cell when the block is
   inconsistent and the row has unlogged dollars; footnote states stored-through and the inconsistency; all-time footer
   is tri-state (loading / value / failed).

## Acceptance
- Unit: `mantleModelsToQuery` union + shape filter; `foldMantle` sums, fleet, days; `bill-parse` 30m rows; suite green.
- Dry run (no writes) against live CloudWatch for 2026-10-01 → 10-27: opus-5-5 5,816 by name; per-model sum 6,256 ==
  fleet 6,256 (CONSISTENT) — the same window that read "—" / inconsistent on the deployed code.
- After the owner deploys Etl + Api: one collector backfill `{start: 2026-10-01, end: <today>}`; `/v1/overview?window=mtd`
  opus-5-5 row carries `mantle.inferences` 5,816 and `mantleInconsistent` is absent; `mantleStoredThrough` = yesterday.

## Out of scope
Pricing Mantle tokens; Metric Streams (P1); the ROI MTD button (F-PR77-007, P3).
