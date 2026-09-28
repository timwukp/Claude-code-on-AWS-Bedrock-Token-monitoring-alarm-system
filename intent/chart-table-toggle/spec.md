# Spec: Chart | Table twin

- **Intent:** ./intent.md
- **Author:** Claude (AI agent)
- **Accepted-by:** Tim WU
- **Status:** signed-off

## Behaviour

### 1. `components/ChartTable.tsx` (new)
`ChartTable<T>({ label, rows, columns, rowKey, children, defaultView = 'chart' })`.
- Renders a `.seg.seg-sm` group (`role="group"`, `aria-label="View <label> as"`) with two buttons **Chart** and
  **Table**, `aria-pressed` on the active one, right-aligned above the content.
- Chart view renders `children` (the existing Recharts block) unchanged. Table view renders `table.data` with an
  `sr-only` `<caption>` "<label> — the same data as the chart", `<th scope="col">` headers, `.num` on numeric
  columns; the chart is not mounted in table view.
- `columns[]`: `{ header, cell(row) → ReactNode, num? }`. Cells are formatted by the caller with the portal's
  helpers, so table figures match tiles and tooltips.
- View state is local to the panel; the default is the chart.

### 2. Panels converted
| Page | Panel | Table columns |
|---|---|---|
| Usage | Token consumption over time | Day / Hour (UTC) · Input tokens · Output tokens · Invocations |
| DORA | Merges to the default branch per week | Week · Human-only PRs · AI-assisted PRs · Total |
| DORA | Lead time per week | Week · Median lead time (`—` "no merges that week" when null) · Merged PRs |
| AI ROI | <project> — ROI components | Component · Side (Value / Investment) · Annual USD (signed) |

The Usage panel keeps its empty state; the twin renders only when there are points.

### 2b. ROI model diagram layout (owner-reported, same page)
In `RoiModelDiagram.tsx` the three provenance lines under the legend overlapped the ROI result box and the first
one overflowed the SVG width. Provenance moves below the result box (starting y 430), the Adoption-dip sentence
becomes two lines, the refusal note follows at y 494, and the viewBox height becomes 506. No text changes.

### 3. Styles
`.chart-table-bar` (flex, right-aligned, small bottom margin), `.chart-table-data`, `.sr-only`; the bar is hidden
in `@media print`.

## Out of scope
`LatencyPage.tsx` (feature-28 in flight); Overview sparklines (decorative, the tile states the figure); CSV export.
