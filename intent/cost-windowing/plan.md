# Plan: Cost page windowing (feature-27)

- **Spec:** ./spec.md
- **Author:** Claude (AI agent)
- **Accepted-by:** Tim WU
- **Accepted-for:** 91bb02a1ea256c71b0095ce0ec04fece072b2638
- **Status:** shipped

`Accepted-for` is the tip of `main` after PR #56 (feature-26), the merge base at branch time. Nothing else
is in flight.

## Files changed
1. `backend/lambdas/api/overview-calc.ts` — `OverviewModelRow.cacheSavingsUsd`, summed per model from `computeModelCost`.
2. `backend/lambdas/api/overview-calc.test.ts` — asserts the new field and that it sums across regional variants.
3. `frontend/src/api/client.ts` — `OverviewResponse.byModel[].cacheSavingsUsd?` (optional: older API builds omit it).
4. `frontend/src/main.tsx` — `PAGE_META['/costs'].windows = [7, 30, 90, 'mtd']`; fixed caption removed.
5. `frontend/src/pages/CostsPage.tsx` — windowed tiles and table from `/v1/overview`; all-time footer from `/v1/costs`.
6. `frontend/src/pages/OverviewPage.tsx` — Budget tile names its source as billed spend, not the token estimate.
7. `frontend/src/pages/AnomaliesPage.tsx` — single time-range control (in-feed shortcut removed).
8. `frontend/src/lib/help-content.ts` — `cost.estimated-spend`, `cost.cache-savings` window caveats.

Non-source riders: `.sdlc/active` (handover from `qa-loop-honesty`), `intent/qa-loop-honesty/*` → shipped,
`intent/cost-windowing/*`, `CHANGELOG.md`, `docs/test-reports/feature-27-cost-windowing.md` plus its index row,
and `docs/test-reports/feature-26-qa-loop-honesty.md` (its "recorded below once it lands" placeholders closed
with the green run — docs only).

## Verification
- backend `jest` + `tsc --noEmit`; frontend `tsc --noEmit` + `vite build`; SDLC gate dry-run with `--require-active`.
- Local render against the deployed API (field absent): Cost shows windowed spend/tokens, `—` for cache savings,
  footer all-time; switching the picker refetches; Overview Budget tile carries the source note; Anomalies
  empty state has one action.
- After the owner-authorised `Tums-dev-Api` deploy: invoke `OverviewFn` with `/tmp/ev-overview.json`, assert
  every `byModel` row has `cacheSavingsUsd` and Σ over 30 days ≤ the all-time `totalCacheSavingsUsd` from
  `/v1/costs`; Cost 30-day spend equals Overview's Spend tile to the cent.
- Live via qa after push.

## Risks
- Until the Api is redeployed, dev's Cost page shows `—` for cache savings — stated inline, not silent.
- `/v1/overview` reads PROJDAY rollups, `/v1/costs` the model aggregates; both are fed by the same aggregator
  and priced by the same rate card, so a windowed total that disagrees with the all-time footer for a window
  covering all data would expose an ingestion gap rather than a pricing one — checked in the live step.
