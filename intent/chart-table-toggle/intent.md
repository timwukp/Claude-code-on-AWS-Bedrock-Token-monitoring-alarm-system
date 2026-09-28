# Intent: every chart has a table twin

- **Slug:** chart-table-toggle
- **Author:** Claude (AI agent)
- **Date:** 2026-09-24
- **Accepted-by:** Tim WU
- **Status:** accepted

## Problem

Four panels on the portal exist only as Recharts drawings: token consumption over time (Usage), merges per
week and lead time per week (DORA), and the ROI components waterfall (AI ROI). A drawing cannot be read by a
screen reader, cannot be tabbed through, does not print legibly in dark theme, and its exact values are only
reachable through a hover tooltip — which the chart standard adopted in `docs/research-dashboard-ux.md`
(chart standard 6, "Tooltip never gates") forbids as the sole path to a number. The audit listed the missing
table twin as the one unresolved item from the chart standards after features 20–27.

## Evidence

Research finding R5 (3-0) and the dataviz method's accessibility pass: for every chart a table view exists;
identity is never colour-alone. The data behind each of the four charts is already an array in component
state, so the table costs one shared component and no API change.

## Desired outcome

- A `ChartTable` component: one "Chart | Table" segmented control above the plot; the table is the portal's
  standard `table.data`, with a caption naming the data, right-aligned numeric columns and `—` (labelled) for
  gaps; the chart is unmounted in table view.
- The four panels above use it. Column headers carry the unit; formatting uses the portal's `fmt*` helpers so
  a table figure equals the tile/tooltip figure.
- The control is hidden in print; the chart view stays the default.

## Non-goals

- No change to the charts themselves, their data or their colours.
- `LatencyPage.tsx` is left alone: it is being changed by the latency-per-project chain (feature-28) in
  parallel; its charts get the twin after that lands.
- No CSV export (the table copies as text, which covers the stated need).
