# Feature 23 — Overview landing page + `/v1/overview`

- **Chain:** `intent/overview-page/` · **Branch:** `feat/overview-page` off `main@4ea7eb8` (post-#49) · **PR:** TBD
- **Origin:** `docs/research-dashboard-ux.md` defect 1 / finding R1 — the portal landed on a raw chart;
  four primary sources (AWS Billing, Vantage, Cloudscape, Carbon) open on headline KPIs + "what changed".
- **Date:** 2026-09-18
- **Verdict:** PASS on gates and the local authenticated render; live validation of the new endpoint is
  recorded below once the API is deployed (see the deploy note).

## Three things this report has to say plainly

1. **The endpoint is additive and reconciles by construction.** It reads the same PROJDAY rollups and
   rate card as the Cost and Projects pages, so the Overview's 30-day spend equals Σ Projects for the
   same window to the cent; no new source of truth was introduced.
2. **Deltas name their comparison period** ("vs 08-19 – 09-17"), and when the rollups begin inside
   that period the tile says **partial history** and the panel says the baseline is incomplete. Per-project
   rollups only began in September 2026, so this state is the norm for weeks, not an edge case.
3. **API deploy is deliberately deferred.** The other active session has three prepared Lambda updates
   for dev waiting on the owner; a `cdk deploy Tums-dev-Api` from this branch first would overwrite those
   functions with this branch's build. Until the owner runs or drops that deploy, dev serves this PR's
   frontend against an API without `/v1/overview`, and the Spend tile / movers panel show their explicit
   error state (verified below) — the page never blanks.

## Scope
| File | Change |
|---|---|
| `backend/lambdas/api/overview-calc.ts` | new — `windowBounds` (7/30/90 + mtd with month-length clamp), `buildOverview` |
| `backend/lambdas/api/overview-calc.test.ts` | new — 10 tests |
| `backend/lambdas/api/overview.ts` | new handler — PROJDAY range read, registry names, watermark |
| `backend/lambdas/api/governance.ts` | additive `billingDataAvailable`, `forecastAvailable` |
| `infra/lib/stacks/api-stack.ts` | `OverviewFn` + `GET /v1/overview` |
| `frontend/src/pages/OverviewPage.tsx` | new |
| `frontend/src/lib/budget-status.ts` | new |
| `frontend/src/api/client.ts` | `overview()`, `OverviewResponse`, `GovernanceBudget` |
| `frontend/src/main.tsx` | `/` → Overview, `/usage` → Usage |
| `frontend/src/components/Layout.tsx` | Overview nav group; Usage → `/usage` |
| `frontend/src/lib/help-content.ts` | `overview.*` entries |
| `frontend/src/styles.css` | `.delta-up`, `.delta-down` |

## Gates
| Gate | Result |
|---|---|
| Backend `tsc --noEmit` / `jest` | PASS — 188/188, 20 suites (+10) |
| Frontend `tsc --noEmit` / `vite build` | PASS |
| Infra `tsc --noEmit` / `cdk synth --context env=ci` | PASS |
| `sdlc_ci_gate.py --require-active` | PASS — 12 source files, all named in the plan |

## Local authenticated render (live dev API, endpoint not yet deployed)
| Route | Result |
|---|---|
| `/` | h1 "Overview"; nav Overview · Usage · Cost · By project · Budgets & guardrails · Anomalies · DORA metrics · AI ROI; Budget `$0.00` "On track" (forecast $15.34); Anomalies 0 "none detected"; Deployment frequency `0.6 / week` median across 6 synced repositories; Spend tile in explicit error state; movers panel shows an error `EmptyState` with Retry |
| `/?window=7` | Deployment frequency `0.9 / week`, captions follow the range |
| `/usage` | the former landing page, unchanged (4 KPIs) |
| `/nope` | redirects to `/` (Overview) |
| console / page errors | only the failed `/v1/overview` fetches (expected until deploy) |

## Live validation (dev)
_At API deploy:_ direct invoke of `OverviewFn` for `window=30`; assert `spend.currentUsd` equals Σ Projects
(Fast) for the same 30 days to the cent, `deltaPct` null or finite, `daily` has 30 entries, `coverage`
consistent with `firstDayWithData`; served bundle hash; Spend tile and movers populated; 0 console errors.

## Leak scan
`grep -nE '[0-9]{12}|AKIA|arn:aws'`: no matches.
