# Feature 27 — Cost page windowing (Cost follows the portal's time range)

- **Chain:** `intent/cost-windowing/` · **Branch:** `feat/cost-windowing` off `main@91bb02a` (post-#56) · **PR:** #57
- **Origin:** research finding R2 (one time model across the portal); qa LOWs on #55/#56 (Budget tile beside Spend
  tile; Anomalies two controls for one state).
- **Date:** 2026-09-23
- **Verdict:** PASS on gates and the local authenticated render against the deployed dev API; live via qa recorded below.

## What this report has to say plainly
- **The three spend pages now reconcile to the cent for the same range.** Cost (last 30 days) $2,176.30 =
  Overview Spend $2,176.30, both from `/v1/overview?window=30`. Before this change Cost showed $14,607.30
  (all time) next to an Overview showing $2,176.30, with no visible reason.
- **One column is honestly blank until the API is redeployed.** `byModel[].cacheSavingsUsd` is new on the
  backend; the deployed `OverviewFn` predates it, so the Saved-by-caching tile and column read "—" with the
  reason stated. The Api deploy is a Protected-Scope action for the owner; the live section below is filled
  after it.
- **Per-model rounding is disclosed, not hidden.** On 7d and 90d the shown rows sum one cent below the tile;
  the footer now says so and names the folded sub-cent models — the same class of finding qa raised on the
  Projects page (F-1706), pre-empted here.

## Scope
| File | Change |
|---|---|
| `backend/lambdas/api/overview-calc.ts` | `OverviewModelRow.cacheSavingsUsd` summed per model in the current window (from `computeModelCost`) |
| `backend/lambdas/api/overview-calc.test.ts` | new test: savings = cache-read tokens × (full input − cache-read rate), current window only |
| `frontend/src/api/client.ts` | `byModel[].cacheSavingsUsd?` — optional, older API builds omit it |
| `frontend/src/main.tsx` | `/costs` gets `windows: [7, 30, 90, 'mtd']`; fixed "All time" caption removed |
| `frontend/src/pages/CostsPage.tsx` | tiles + table from `/v1/overview` for the selected range (delta vs prior period, sparkline, partial-history chip); all-time footer from `/v1/costs`; "—" for savings when absent; cent-gap disclosure; empty state per range |
| `frontend/src/pages/OverviewPage.tsx` | Budget tile definition: "AWS Budgets billed spend — not the token estimate in the Spend tile" |
| `frontend/src/pages/AnomaliesPage.tsx` | empty-state action is always "View budget guardrails"; in-feed window shortcut removed |
| `frontend/src/lib/help-content.ts` | `cost.estimated-spend`, `cost.cache-savings`: range caveats |

## Gates
| Gate | Result |
|---|---|
| Backend `jest lambdas/api/overview-calc.test.ts` | PASS — 11/11 |
| Backend `tsc --noEmit` | PASS |
| Frontend `tsc --noEmit` / `vite build` | PASS |
| `sdlc_ci_gate.py --require-active` | PASS — 8 source files, all named in the plan; approval bound to `91bb02a` |

## Local authenticated render (build served on :4177, live dev API, owner's session)
| Check | Result |
|---|---|
| Picker on `/costs` | `7d · 30d · 90d · MTD`, URL-synced; each switch issues exactly one `/v1/overview?window=…` plus one `/v1/costs` |
| 30 d | Estimated spend **$2,176.30**, ▼ −81% vs 07-26 – 08-24; 6 models (8 ids); cache-read 2.54B; 5 rows + 1 folded; totals row $2,176.30 |
| 7 d | $1,312.04, ▲ +310% vs 09-10 – 09-16; rows sum $1,312.03 — footer discloses the cent and the folded model |
| 90 d | $14,326.06; 20 models; "partial history" chip and "rollups begin 2026-07-22" (prior window predates the rollups) |
| MTD | $1,635.62, ▼ −83% vs 08-01 – 08-23 |
| Reconciliation | Overview Spend (30 d) $2,176.30 = Cost (30 d) $2,176.30 |
| Saved by prompt caching | "—" with "not available for this time range until the API is redeployed…"; column cells and total "—"; sort button disabled |
| Footer | "All time: $14,607.30 across 26 model ids …" on every window |
| Overview Budget tile | definition ends "AWS Budgets billed spend — not the token estimate in the Spend tile" |
| `/anomalies?window=90` and `?window=7` | one action ("View budget guardrails"); disclosure "Show 2 older detections — before …" opens 2 rows |
| Console errors | 0 across all routes |

## Live (after the owner-authorised `Tums-dev-Api` deploy)
_To be filled: invoke `OverviewFn` with `/tmp/ev-overview.json`; assert every `byModel` row has `cacheSavingsUsd`,
Σ(30 d) ≤ all-time `totalCacheSavingsUsd`; Cost page tile shows a dollar figure._

## Risks and open points
- Until the Api is redeployed, dev's Cost page shows "—" for cache savings — stated inline.
- The 90-day delta (+4195%) is against a prior window that predates the rollups; the "partial history" chip and
  the caption carry that. A reader who ignores both will over-read the delta — same trade as on Overview.
