# Plan: Mantle visibility (feature-40)

- **Spec:** ./spec.md
- **Author:** Claude (AI agent)
- **Accepted-by:** Tim WU
- **Accepted-for:** e849de83bce185a99485c2b8cd642dfdc3c10512
- **Status:** accepted

`Accepted-for` is the tip of `main` after PR #72 (qa-leftovers, feature-39); the only chain in flight (peer's B waits).

## Files changed
1. `backend/lambdas/ingestion/bill-parse.ts`, `backend/lambdas/ingestion/bill-parse.test.ts` (new)
2. `backend/lambdas/ingestion/bill-collector.ts` (new)
3. `backend/lambdas/ingestion/aggregator.ts` — `recordTenants` → `SYSTEM#TENANTS`
4. `backend/lambdas/api/bill-calc.ts`, `backend/lambdas/api/bill-calc.test.ts` (new)
5. `backend/lambdas/api/bill-read.ts` (new); `backend/lambdas/shared/logged-estimate.ts` (new) — the logged side is
   computed by the collector over every tenant (thousands of identity ARNs) and stored as `LOGGED#DAILY`; readers never
   walk tenants per page view (the first cut did, and timed out live); `backend/scripts/seed-tenant-index.ts` (new,
   one-time seed of `SYSTEM#TENANTS` from the table's PROJDAY partitions)
6. `backend/lambdas/api/costs.ts`, `backend/lambdas/api/overview.ts`, `backend/lambdas/api/latency.ts`
7. `backend/package.json`, `backend/package-lock.json` — `@aws-sdk/client-cost-explorer`
8. `infra/lib/stacks/etl-stack.ts`, `infra/lib/stacks/api-stack.ts`
9. `frontend/src/api/client.ts`, `frontend/src/pages/CostsPage.tsx`, `frontend/src/pages/OverviewPage.tsx`,
   `frontend/src/pages/LatencyPage.tsx`
10. qa round 1 on the PR (owner chose to ride it here): `infra/lib/stacks/automation-stack.ts` — the Budget's CostFilters
    name all three Bedrock service names (it named "Amazon Bedrock" only → watched 0.02% of spend, F-PR73-006);
    `frontend/src/lib/help-content.ts` `budget.actual` caveat; `docs/RECONCILIATION.md` "payer account" section
    corrected. `bill.scope` + `tenantLoggedEstimateUsd` for F-PR73-001.

Non-source riders: `.sdlc/active` (handover from `qa-leftovers`), `intent/qa-leftovers/*` → shipped,
`intent/mantle-visibility/*`, `docs/research-mantle-unlogged-spend.md`, `CHANGELOG.md`, `docs/RECONCILIATION.md`,
`docs/test-reports/feature-40-mantle-visibility.md` plus its index row.

## Order
docs(sdlc)+research → feat(collector + parser) → feat(api) → feat(infra) → feat(frontend) → owner deploys Etl then Api
(both carry IAM: new role + ce:GetCostAndUsage; CloudWatch read on Costs/Overview) → manual collector invoke → live
checks → frontend deploy → report → PR.

## Verification
Gates; the unit and mutation list in the spec; live checks named in the spec; the collector's first run read within a
minute of invoking it ([[probe-under-the-deployed-identity]]).

## Risks
- The bill lags ~1 day; the panel states "bill through <day>" and compares only billed days.
- Cost Explorer must stay enabled for the account; a disabled CE makes the collector fail loudly (no silent zeros).
- Mantle series vs fleet disagreement is flagged, not hidden.
