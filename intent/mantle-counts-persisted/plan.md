# Plan: Mantle counts persisted (feature-46)

- **Spec:** ./spec.md
- **Author:** Claude (AI agent)
- **Accepted-by:** Tim WU
- **Accepted-for:** 065c44e80795ea7c46bb60a03d23034f29caa0bb
- **Status:** accepted

`Accepted-for` is the tip of `main` after PR #79 (lakehouse-p1-bronze, feature-45) — the chain this one follows (owner,
2026-10-27: "2. A, can do"); the only chain in flight.

## Files changed
1. `backend/lambdas/shared/mantle-metrics.ts` (new), `backend/lambdas/shared/mantle-metrics.test.ts` (new)
2. `backend/lambdas/ingestion/bill-collector.ts`
3. `backend/lambdas/ingestion/bill-parse.ts`, `backend/lambdas/ingestion/bill-parse.test.ts`
4. `backend/lambdas/api/bill-read.ts`, `backend/lambdas/api/bill-calc.ts`, `backend/lambdas/api/latency.ts`
5. `infra/lib/stacks/etl-stack.ts`
6. `frontend/src/api/client.ts`, `frontend/src/pages/CostsPage.tsx`, `frontend/src/pages/OverviewPage.tsx` (qa F-PR80-001 rider:
   the deployment-frequency tile sums raw merge counts `df.n` and divides once, instead of summing per-repo 2-dp daily rates)
7. Docs: `docs/RECONCILIATION.md`, `CHANGELOG.md`, `docs/test-reports/feature-46-mantle-counts-persisted.md` (new),
   `docs/test-reports/README.md`
8. SDLC: `intent/mantle-counts-persisted/intent.md`, `intent/mantle-counts-persisted/spec.md`,
   `intent/mantle-counts-persisted/plan.md`, `.sdlc/active`, `intent/lakehouse-p1-bronze/intent.md`,
   `intent/lakehouse-p1-bronze/spec.md`, `intent/lakehouse-p1-bronze/plan.md` (→ shipped)

## Order
shared module + tests → collector stores → readers read the table (+ live tail) → 30m usage type → frontend row flag +
tri-state footer → docs → gates → dry run against live CloudWatch (no writes) → push after #79 merges → PR → qa → owner
deploys Etl (IAM: two CloudWatch read actions on BillCollectorFn) then Api (code) → one collector backfill → live check →
owner merge.

## Verification
Backend jest + tsc; frontend tsc + build; cdk synth; this gate; leak scan; dry run: 2026-10-01 → 10-27 opus-5-5 5,816 by
name, per-model sum == fleet 6,256. After deploy: `/v1/overview?window=mtd` opus row has `mantle.inferences`, no
`mantleInconsistent`, `mantleStoredThrough` = yesterday; `/v1/latency?window=30` Mantle block lists opus-5-5 again.

## Risks
- The Etl deploy carries IAM (`cloudwatch:GetMetricData`, `cloudwatch:ListMetrics` on `*` for the collector) — told the
  owner; `cdk diff` read first.
- Until the backfill runs, stored days are empty and the live tail covers the whole window with recent-only discovery —
  i.e. today's behaviour, no worse. The collector's daily run then fills forward; the one-off backfill fills back.
