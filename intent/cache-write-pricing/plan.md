# Plan: price prompt-cache writes (feature-36)

- **Spec:** ./spec.md
- **Author:** Claude (AI agent)
- **Accepted-by:** Tim WU
- **Accepted-for:** ca0ba29260aa005b26b1afdbaa72229e193b69c6
- **Status:** shipped

`Accepted-for` is the tip of `main` after PR #68 (cost-id-consistency, feature-35) merged; this chain waited for it so
nothing was in flight alongside. The peer's next chain (`cache-cost-truth`) queues behind this one and reads the fields
it creates.

## Files changed
1. `backend/lambdas/api/cost-calc.ts`, `backend/lambdas/api/cost-calc.test.ts` — cache-write rates, `cacheWriteOf`,
   new `ModelCost` / `CostSummary` fields, `nova-micro` row.
2. `backend/lambdas/ingestion/parse.ts`, `backend/lambdas/ingestion/parse-cache-write.test.ts` (new),
   `backend/lambdas/ingestion/parse-attribution.test.ts` — `cacheWriteTtlOf`, `CacheWriteCounters`, counters on the
   three aggregates, runaway pricing, untagged-profile fall-through.
3. `backend/lambdas/ingestion/aggregator.ts` — `CW_CLAUSE` on all four writers, `priceRecordUsd`, `lastRunAt`,
   untagged-profile model mapping.
4. `backend/lambdas/ingestion/cache-write-ddb.ts`, `backend/lambdas/ingestion/cache-write-ddb.test.ts` (new) — the
   backfill's add-only expression.
5. `backend/scripts/backfill-cache-write.ts` (new); `backend/scripts/verify-cache-write-backfill.ts` (new, read-only:
   USAGE vs MODEL/PROJECT/PROJDAY sums, split ≤ total, marker census); `backend/scripts/reconcile-cache-write.ts` (new:
   truth from every raw object vs stored, per item; ADDs positive deltas, refuses negative ones unless
   `--correct-over-counts`); `backend/scripts/repair-projday-day.ts` (`COUNTERS`); `backend/scripts/backfill-projday.ts`
   (header only: marked superseded for the cache-write counters).
6. `backend/lambdas/shared/project-registry.ts`, `backend/lambdas/shared/project-registry.test.ts` —
   `profileResolvesModel`, `loadAttributionMaps`.
7. `backend/lambdas/api/queries.ts`, `backend/lambdas/api/queries.test.ts` — `rateCase` cache-write field, `byProject`
   term, `buildModelExpr`.
8. `backend/lambdas/api/projects.ts`, `backend/lambdas/api/projects-sql.test.ts` — `cacheWriteOf` on both mappers,
   `CACHE_WRITE` in `buildFullSql`.
9. `backend/lambdas/api/costs.ts`, `backend/lambdas/api/overview.ts` (+ `rollupsLastRunAt`), `backend/lambdas/api/roi.ts`,
   `backend/lambdas/api/dora.ts`, `backend/lambdas/api/usage.ts` — mappers spread `cacheWriteOf`.
10. `backend/lambdas/api/project-calc.ts`, `backend/lambdas/api/project-calc.test.ts`, `backend/lambdas/api/roi-calc.ts`,
    `backend/lambdas/api/roi-calc.test.ts`, `backend/lambdas/api/overview-calc.ts`,
    `backend/lambdas/api/overview-calc.test.ts` — `ProjdayItem` fields passed to pricing; `OverviewModelRow.cacheWriteTokens`.
11. `frontend/src/api/client.ts`, `frontend/src/pages/CostsPage.tsx`.
12. `infra/lib/stacks/api-stack.ts` — one read grant: `tables.tenants.grantReadData(costsFn)` (qa F-PR69-004: the
    Costs Lambda resolves profile-ARN-keyed rows to their model through the registry's profile cache at read time, as
    `projects`, `overview`, `roi` and `dora` already may — they held the grant).

Non-source riders: `.sdlc/active` (handover from `cost-id-consistency`), `intent/cost-id-consistency/*` → shipped,
`intent/cache-write-pricing/*`, `docs/research-cache-write-pricing.md`, `CHANGELOG.md`,
`docs/test-reports/feature-36-cache-write-pricing.md` plus its index row.

## Order
1. Pricing core + ingestion + backfill + API (this plan's items 1–10), gates green, mutation checks.
2. Pre-deploy validation against live inputs: Athena by-model × new card vs Cost Explorer (done before any push).
3. Owner deploys `Tums-dev-Etl` and `Tums-dev-Api`; record the deploy time as `BACKFILL_UNTIL`.
4. Backfill dry run → compare the token total with Athena → `--apply` (owner OK; ≈ one DynamoDB write per log object).
   Long bucket walks run on a throw-away EC2 job runner (owner rule 2026-10-07), not the laptop; reports to S3.
   `verify-cache-write-backfill.ts` must pass; any claimed-not-done marker → `reconcile-cache-write.ts`.
5. Live checks on the deployed Lambdas; frontend build, deploy, served-bundle check.
6. Docs, PR with its repricing section.

## Verification
- Backend `jest` + `tsc --noEmit`; frontend `tsc` + `vite build`; `cdk synth -c env=ci`; `sdlc_ci_gate.py
  --require-active`. Mutations: drop the cache-write term / zero the unknown bucket / filter ignoring cache write /
  net using the full write cost / 1 h = 5 m / drop the sum-equality check / drop the 1 h fold / read the last chunk /
  skip the lift / return the untagged profile outright — each must fail at least one test.
- Reconciliation inside the logging window (2026-06-04 → 10-05): estimated cache write × route vs Cost Explorer per
  model and in total; the pre-logging days (06-01 → 06-03 06:54Z) are named, not folded into a residual.
- Backfill: dry-run token total = Athena `SUM(cacheWriteInputTokenCount)` before the cut-off; after apply, MODEL Σ =
  USAGE Σ for the largest tenant; 0 claimed-not-done.
- Live: `/v1/costs` and `/v1/overview` totals and the new fields; one post-deploy hour shows a 5 m split > 0; the three
  Nova profiles price > $0.

## Risks
- `estimatedUsd` moves on every page at once (+77% for the largest tenant). The PR body carries before/after and the
  reconciliation; the Cost page carries the lower-bound note.
- The backfill adds ≈ one marker per log object; a crash mid-object is reported, never re-added (under-count visible).
- Peer's chain depends on the field names in this plan; they are fixed.
