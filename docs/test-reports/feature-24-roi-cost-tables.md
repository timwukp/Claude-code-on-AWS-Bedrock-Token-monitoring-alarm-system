# Feature 24 — ROI + Cost tables (one table + one chart; merged model rows, totals, folded noise)

- **Chain:** `intent/roi-cost-tables/` · **Branch:** `feat/roi-cost-tables` off `main@7c67e8b` (post-#51) · **PR:** TBD
- **Origin:** `docs/research-dashboard-ux.md` defects 7–9 (ROI 18 stacked charts; Cost raw ids, split
  variants, `$0.00` noise, no totals) and qa F-PR51 LOW (Anomalies dead widen button at 90 days).
- **Date:** 2026-09-19
- **Verdict:** PASS on gates and the local authenticated render; live via qa recorded below.

## What this report has to say plainly
- **Cost is still all-time.** The plan's windowed Cost table depends on `/v1/overview`, which is merged
  (#51) but not yet deployed to dev. Adding that dependency now would only produce another
  environment-caused HIGH; the windowing lands once the endpoint is live and verified.
- **The ROI table shows "not computable" reasons in four short forms**, with the full refusal sentence on
  hover *and* in the detail panel below the table — a clipped reason is never the only copy.

## Scope
| File | Change |
|---|---|
| `frontend/src/pages/RoiPage.tsx` | `?project=` selection shared by table, detail, diagram and estimator; sortable table with `aria-sort`; one detail panel replaces 18 |
| `frontend/src/pages/CostsPage.tsx` | `mergeModelRows` (ARN prefix stripped), friendly names + raw ids, region chips, compact tokens, sortable headers, zero-cost toggle, totals row, "All time" footer, `EmptyState` |
| `frontend/src/pages/AnomaliesPage.tsx` | at 90 days the empty state links to guardrails; detail explains the 100-record cap |
| `frontend/src/styles.css` | `.th-sort`, `.row-clickable`, `.row-selected`, `.total-row`, `.model-name`, `.model-id`, `.region-chip` |

No numbers, API or `format.ts` change.

## Gates
| Gate | Result |
|---|---|
| Frontend `tsc --noEmit` / `vite build` | PASS |
| `sdlc_ci_gate.py --require-active` | PASS — 4 source files, all named in the plan |

## Local authenticated render (live dev API)
| Check | Result |
|---|---|
| `/roi` page height | **9 822 px → 3 599 px** |
| `/roi` table | 10 rows (projects with spend/merges, last 30 days); default sort spend desc; ROI sort puts computable rows first |
| row click | URL gains `?project=token-monitoring`; detail panel, diagram and estimator follow |
| `/costs` | 26 raw ids → 17 merged rows; 8 shown, 9 folded behind "Show 9 models below $0.01"; totals row `$14,345.41`; 13 region chips |
| `/anomalies?window=90` | empty-state action is "View budget guardrails" |
| console / page errors | 0 (excluding the expected `/v1/overview` fetch on the Overview page) |

## Live validation (dev)
_Via qa after push:_ served hash; the checks above on the served site.

## Leak scan
`grep -nE '[0-9]{12}|AKIA|arn:aws'`: no matches.
