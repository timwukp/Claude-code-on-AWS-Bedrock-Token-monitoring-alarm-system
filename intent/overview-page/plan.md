# Plan: overview page (feature-23)

- **Spec:** ./spec.md
- **Author:** Claude (AI agent)
- **Accepted-by:** Tim WU
- **Accepted-for:** c55ceb0ed5345bc43a801f1510bd40d80ae5fa9f
- **Status:** accepted

`Accepted-for` is the tip of `main` after PR #50 — main was merged into this branch after #50 landed (a re-acceptance; first accepted against `4ea7eb8`). Numbered 23 because
the other active session took 22 (`anomaly-key-shape`) and 18 stays reserved for `latency-observability`.
Whichever of those lands second takes a small mechanical merge in `api-stack.ts`, `main.tsx`, `Layout.tsx`
and `client.ts`; this chain keeps its additions in separate blocks.

## Files changed

### Backend
1. `backend/lambdas/api/overview-calc.ts` — new, pure: `windowBounds`, `buildOverview`.
2. `backend/lambdas/api/overview-calc.test.ts` — new: equal-period split, mtd rules (day 1, month-length clamp), null deltaPct, zero-filled series, regional variants, movers ranking/cap, coverage flag.
3. `backend/lambdas/api/overview.ts` — new handler: PROJDAY range read, registry names, watermark.
4. `backend/lambdas/api/governance.ts` — additive `billingDataAvailable` / `forecastAvailable`.

### Infra
5. `infra/lib/stacks/api-stack.ts` — `OverviewFn` (mirrors `RoiFn`; tenants + aggregates read) and `GET /v1/overview`.

### Frontend
6. `frontend/src/pages/OverviewPage.tsx` — new.
7. `frontend/src/lib/budget-status.ts` — new.
8. `frontend/src/api/client.ts` — `overview()`, `OverviewResponse`, `GovernanceBudget`.
9. `frontend/src/main.tsx` — `/` → Overview, `/usage` → Usage, `PAGE_META` entries.
10. `frontend/src/components/Layout.tsx` — Overview nav group/item; Usage → `/usage`.
11. `frontend/src/lib/help-content.ts` — `overview.spend/budget/anomalies/movers`.
12. `frontend/src/styles.css` — `.delta-up`, `.delta-down`.

Non-source riders: `.sdlc/active` (handover from `anomaly-key-shape`, which #50 shipped), `intent/anomaly-key-shape/*` →
shipped, `intent/projects-roi-followups/*` → shipped (already on main via #50), `intent/overview-page/*`, `CHANGELOG.md`,
`docs/test-reports/feature-23-overview-page.md` plus its index row.

## Verification
- backend `jest` (+10) + `tsc`; frontend `tsc` + `vite build`; infra `tsc` + `cdk synth --context env=ci`; SDLC gate dry-run.
- Local authenticated render: `/` is Overview with four tiles and the movers panel; `/usage` is the old
  Usage page; unknown routes → Overview; the Spend tile and movers degrade to explicit error states while
  the endpoint is not deployed (verified — the page never blanks).
- Live: deploy `Tums-dev-Api` **only after the other session's pending Lambda deploy has been run or dropped
  by the owner** (deploying first would overwrite AnomaliesFn/AggregatorFn with this branch's build); then
  invoke `OverviewFn` directly and assert `spend.currentUsd` for 30 days reconciles with Σ Projects for the
  same window; frontend via qa; recorded in the report.

## Risks
- **PROJDAY history is short** (rollups began 2026-09 with #39): 90-day and even 30-day prior periods are
  partial for weeks — `coverage.partial` drives an explicit caption and a "partial history" chip.
- **Budget "no billing data"** relies on AWS returning no `ActualSpend.Amount`; if it returns "0" the tile
  shows On track at $0 — still truthful, just less specific. Verified at the API deploy.
- **Merge with feature-18/22** in `api-stack.ts`/`main.tsx`/`Layout.tsx`/`client.ts` — additive blocks, mechanical.
