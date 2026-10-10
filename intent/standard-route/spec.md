# Spec: price the standard route

- **Intent:** ./intent.md
- **Author:** Claude (AI agent)
- **Accepted-by:** Tim WU
- **Status:** signed-off

## Behaviour

### 1. `backend/lambdas/api/cost-calc.ts`
- `STANDARD_ROUTE_MULT = 1.1`. `ModelRate.routeTiers: boolean` (default true via `rate()`; `nova-micro` false).
- `routeMultiplier(modelId, rate)`: `rate.routeTiers === false` → 1; `normalizeModelId(modelId)` starts with `global.`
  → 1; else 1.1. A bare id (direct call, or a profile resolved to its model) is the standard tier.
- `computeModelCost` multiplies `estimatedUsd`, `estimatedUsdUpperBound`, `cacheReadUsd`, `cacheWriteUsd`,
  `cacheSavingsUsd` and `cacheNetUsd` by the factor and reports it as `ModelCost.routeMultiplier`. Token counts are
  untouched. `summarizeCosts` is unchanged (rows are per normalized id, so `us.x` and `global.x` price separately).
- `routeCaseSql(modelExpr)`: the same rule as a SQL `CASE` — single-tier card rows → 1, `LIKE 'global.%' OR LIKE
  '%/global.%'` → 1, else 1.1 — built from the card so the two paths cannot drift.

### 2. Athena — `backend/lambdas/api/queries.ts`, `backend/lambdas/api/projects.ts`
- `TEMPLATES.byProject` (grouped by model): the four rate terms are wrapped and multiplied by `routeCaseSql(modelExpr)`.
- `buildFullSql` (grouped by project only): each row's four terms are multiplied by `routeCaseSql('l.modelId')` inside
  the `SUM`.

### 3. Copy and docs
- `frontend/src/pages/CostsPage.tsx` pricing note states the route rule; "lower bound" is gone.
- `frontend/src/pages/OverviewPage.tsx` spend tile: "routes priced (global tier, standard ×1.1)".
- `frontend/src/lib/help-content.ts` `overview.spend` and `cost.estimated-spend` caveats rewritten (peer's file, with
  their agreement).
- `frontend/src/api/client.ts`: `routeMultiplier?` on overview rows.
- `docs/RECONCILIATION.md`: the "+5 % to +12 %" row and the standard-route residual are replaced by the rule.
- `docs/incidents/2026-10-cache-write-omission.md`: the lower-bound bullet struck through and marked resolved with the PR.

### Acceptance
- Unit: factor by id shape (`global.`, ARN-of-global, `us.`, `eu.`, `apac.`, bare, ARN-of-us), OpenAI 1.1, Nova 1;
  every dollar field scales and no token count does; `summarizeCosts` keeps tiers as separate rows; SQL CASE text in both
  templates; mutations (factor dropped, bare → 1, Nova → 1.1, net unscaled) each fail a test.
- Bill: estimate × route vs Cost Explorer per model × route × kind, 2026-06-04 → 10-05, total within 0.1%.
- Live after deploy: `routeMultiplier` on every `/v1/costs` and `/v1/overview` row; `global.` rows unchanged,
  standard rows +10%; served bundle has the route sentence and no "lower bound".

## Out of scope
Long-context tiers; ingestion; backfills; the three qa findings outside this chain (#69 round 3).
