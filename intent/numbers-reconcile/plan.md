# Plan: every figure reconciles with the one beside it (feature-34)

- **Spec:** ./spec.md
- **Author:** Claude (AI agent)
- **Accepted-by:** Tim WU
- **Accepted-for:** 3c60f41d42ab1a45b4558fbbef39b24aee833876
- **Status:** accepted

`Accepted-for` is the tip of `main` after PR #66 (dora-tables-topn), the merge base at branch time. Nothing else is in
flight. The next chain, `cost-id-consistency`, waits for this one to merge.

## Files changed
1. `backend/lambdas/api/roi-calc.ts`: `DAYS_PER_YEAR`, `DAYS_PER_MONTH`; `windowDays` in `aiSpend.formulaInputs`.
2. `backend/lambdas/api/roi-calc.test.ts`: (10b) monthly × 12 reproduces the annual figure.
3. `backend/lambdas/api/roi.ts`: `monthlySpendUsd` on `DAYS_PER_MONTH`.
4. `backend/lambdas/api/latency.ts`: `rankModelIds`, `modelRemainder`, `accountVsTenant`, paginated `listModelIds`,
   chunked `fetchSeries`, two-pass handler, `modelRemainder` / `accountVsTenant` / `projects.storageNote` in the
   response, `scopeNote` wording.
5. `backend/lambdas/api/latency.test.ts`: ranking, remainder and account-vs-tenant cases.
6. `backend/lambdas/api/cost-calc.ts`: five point-release rows above their families.
7. `backend/lambdas/api/cost-calc.test.ts`: point-release rates, family rates kept, no-shadowing guard.
8. `frontend/src/api/client.ts`: `modelRemainder`, `accountVsTenant`, `projects.storageNote` types.
9. `frontend/src/components/RoiModelDiagram.tsx`: "in N days × 365/N".
10. `frontend/src/pages/RoiPage.tsx`: "(× 365/N; monthly = annual ÷ 12)".
11. `frontend/src/pages/LatencyPage.tsx`: account-vs-tenant line under the fleet tiles, remainder row, panel
    descriptions, Fast-only note, limitations paragraph.
12. `frontend/src/pages/DoraPage.tsx`: banner label.
13. `frontend/src/pages/ProjectsPage.tsx`: live Full − Fast difference in the panel description.

Non-source riders: `.sdlc/active` (handover from `dora-tables-topn`), `intent/dora-tables-topn/*` → shipped,
`intent/numbers-reconcile/*`, `CHANGELOG.md`, `docs/test-reports/feature-34-numbers-reconcile.md` plus its index row.

## Verification
- backend `jest` + `tsc --noEmit`; frontend `tsc --noEmit` + `vite build`; `cdk synth -c env=ci`; SDLC gate dry-run.
- Mutation check: moving `fable-5` above `fable-5-1` must fail the shadowing guard.
- Deploy `Tums-dev-Api`. Invoke the deployed Latency and ROI Lambdas with an API-Gateway event carrying real claims:
  By-model samples + remainder = fleet samples; account and tenant counts present; ROI monthly × 12 = annual.
- Deploy the frontend, then fetch the served bundle and assert the new strings are present and the superseded ones gone.
- qa after push (frontend path ⇒ qa runs).

## Risks
- **Repricing history.** Stored tokens are priced at read time, so every past total on Cost, Projects and ROI moves
  where these five models were used. The CHANGELOG and the report state the measured change per tenant.
- Pass 1 adds one GetMetricData round trip per 500 listed series (one round trip at today's 13).
