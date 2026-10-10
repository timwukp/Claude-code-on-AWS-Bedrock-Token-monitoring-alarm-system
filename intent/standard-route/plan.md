# Plan: price the standard route (feature-38)

- **Spec:** ./spec.md
- **Author:** Claude (AI agent)
- **Accepted-by:** Tim WU
- **Accepted-for:** 10d3296545d05bd42c7c38e471917da7e07de566
- **Status:** accepted

`Accepted-for` is the tip of `main` after PR #70 (cache-cost-truth, feature-37) merged; the peer holds nothing and
this is the only chain in flight.

## Files changed
1. `backend/lambdas/api/cost-calc.ts`, `backend/lambdas/api/cost-calc.test.ts` — `STANDARD_ROUTE_MULT`, `routeTiers`,
   `routeMultiplier`, `routeCaseSql`, `ModelCost.routeMultiplier`; route tests; rate-arithmetic fixtures moved to
   `global.` ids.
2. `backend/lambdas/api/cost-calc-openai.test.ts` — the `us.openai` fixture now expects the standard tier.
3. `backend/lambdas/api/queries.ts`, `backend/lambdas/api/queries.test.ts` — route CASE on `byProject`.
4. `backend/lambdas/api/projects.ts`, `backend/lambdas/api/projects-sql.test.ts` — route CASE inside `buildFullSql`'s SUM.
5. `backend/lambdas/api/overview-calc.test.ts`, `backend/lambdas/api/project-calc.test.ts`,
   `backend/lambdas/api/roi-calc.test.ts` — fixtures on `global.` ids (and one test that now asserts the two tiers).
6. `frontend/src/pages/CostsPage.tsx`, `frontend/src/pages/OverviewPage.tsx`, `frontend/src/lib/help-content.ts`,
   `frontend/src/api/client.ts` — caveats replaced by the route rule; `routeMultiplier?` type.

Non-source riders: `.sdlc/active` (handover from `cache-cost-truth`), `intent/cache-cost-truth/*` → shipped,
`intent/standard-route/*`, `CHANGELOG.md`, `docs/RECONCILIATION.md`, `docs/incidents/2026-10-cache-write-omission.md`,
`docs/test-reports/feature-38-standard-route.md` plus its index row.

## Order
docs(sdlc) → feat(cost) → feat(api) → fix(copy)+docs → bill reconciliation recorded → owner deploys `Tums-dev-Api`
(code-only) → live invoke → frontend deploy → served-bundle check → report → PR.

## Verification
Backend `jest` + `tsc`; frontend `tsc` + `vite build`; `cdk synth -c env=ci`; `sdlc_ci_gate.py --require-active`;
mutations named in the spec; the per-kind reconciliation table in the report; live checks after the deploy.

## Risks
- Every dollar figure moves +10% for standard-route tenants at once; the PR body carries before/after and the
  reconciliation, and the pages no longer call the figure a lower bound.
- A route the rule does not know (a new geo prefix) takes the standard tier — the conservative direction, since every
  non-global tier on the list is standard today.
