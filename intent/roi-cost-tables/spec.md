# Spec: ROI and Cost tables

- **Intent:** ./intent.md
- **Author:** Claude (AI agent)
- **Accepted-by:** Tim WU
- **Status:** signed-off

## Behaviour

### 1. `RoiPage.tsx`
- Selection: `?project=<id>` via `useSearchParams`; falls back to the first project with spend/merges;
  the same id drives the model-diagram selector, the estimator reference and the detail panel.
- **Projects — ROI components** panel (help `roi.break-even`): `table.data.roi-table`; columns Project
  (+ `review` badge when kill-fast flagged) · Spend / mo · Break-even h / mo (`h · %cap`) · Evidence
  badge · Value / yr (signed) · Investment / yr · ROI (bold %) or a short reason (`nothing shipped (this
  project's repos)` · `spend too small to rate` · `needs its own team size` · `no investment`), full
  refusal text on `title`. Headers are `<button class="th-sort">` with `aria-sort`; default sort spend
  desc; click toggles direction. Rows are clickable and keyboard-selectable (`tabIndex`, Enter/Space,
  `aria-selected`); the selected row is highlighted.
- One **detail panel** for the selected project, with the previous per-project content unchanged
  (waterfall on the diverging pair, refusals, unit economics, assumptions drawer with admin overrides).
- The break-even strip, portfolio scatter and estimator are unchanged.

### 2. `CostsPage.tsx`
- Rows from `/v1/costs` are merged with `mergeModelRows` (ARN prefix stripped first): one row per
  canonical model with `friendly` name, region chips (`us`, `global`), raw ids as a `.model-id` line.
- Columns: Model · Input tokens · Output tokens · Cache-read · Cache savings (USD) · Est. cost (USD) —
  units in the header, tokens via `fmtTokens`, all numeric headers sortable (`aria-sort`).
- Rows with `estimatedUsd < $0.01` are hidden by default behind "Show N models below $0.01"
  (`aria-expanded`); a `tfoot` totals row sums the visible rows and says "(shown rows)" when filtered.
- "Models used" KPI counts merged models and notes how many raw ids were merged. Footer line: "All
  time: $X across N model ids · the same rate card prices the By project and Overview pages".
- `EmptyState` for loading / error / empty.

### 3. `AnomaliesPage.tsx`
When `range.window === 90` the empty-state action is "View budget guardrails" and the detail says the
older detections are beyond 90 days (the feed keeps the newest 100 overall).

### 4. `styles.css`
`.th-sort`, `tr.row-clickable`, `tr.row-selected`, `tfoot .total-row`, `.model-name`, `.model-id`,
`.region-chip`.

## Out of scope
Cost windowing; numbers; `format.ts`; DORA tables (next chain).
