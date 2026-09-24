# Intent: the Cost page follows the portal's time range

- **Slug:** cost-windowing
- **Author:** Claude (AI agent)
- **Date:** 2026-09-23
- **Accepted-by:** Tim WU
- **Status:** accepted

## Problem

Every monitoring page except Estimated Cost honours the header time-range picker. Cost is pinned to
"All time", so a reader who lands on Overview (last 30 days: $2,168) and clicks through to Cost sees
$14,549 for the same question — "what are we spending, by model?" — with no visible reason for the
gap. Cross-page reconciliation was the core promise of the UX redesign (`docs/research-dashboard-ux.md`,
finding R2); the one page that does not window is the one readers use to check the others.

Two small leftovers from the qa reports on #55/#56 ride along because they are the same class of defect
(two figures next to each other that appear to disagree, with no inline reason):
- Overview's Budget tile can read "$0.00 · On track" beside a Spend tile showing thousands of dollars. The
  budget number is AWS Budgets' *billed* spend, the spend number a *token-based estimate*; the tile does not
  say so unless billing data is entirely absent.
- Anomalies has two controls for one state: the header picker and an in-feed "Show last 90 days" button.
  Since #56 lists the out-of-window detections under the feed, the shortcut is redundant.

## Evidence

Research R2 (3-0): one time model across the portal; every figure states its window. `/v1/overview` already
returns `byModel` for the selected window from the same PROJDAY rollups and the same rate card as `/v1/costs`,
so a windowed Cost table costs one field (per-model cache savings) and no new endpoint.

## Desired outcome

- Estimated Cost honours `?window=7|30|90|mtd`: KPI tiles and the Spend-by-model table show the selected
  window, with the spend delta against the prior equal period; the "All time" line stays as the footer.
- `/v1/overview.byModel[].cacheSavingsUsd` (additive) so the Cache-savings column can be windowed.
- Overview's Budget tile says "billed spend (AWS Budgets), not the token estimate" whenever it shows a number.
- Anomalies keeps a single time-range control.

## Non-goals

- No change to `/v1/costs` or to the rate card.
- No Chart | Table toggles, no DORA table changes (separate chains).
- No "all retained" window in the shared time-range lib: the Anomalies disclosure already exposes older rows.
