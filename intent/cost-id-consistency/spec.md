# Spec: Cost page id consistency

- **Intent:** ./intent.md
- **Author:** Claude (AI agent)
- **Accepted-by:** Tim WU
- **Status:** signed-off

## Behaviour

### 1. `frontend/src/lib/model-names.ts`
- `normalizeModelId(id)`: `id.replace(/^arn:[^/]+\/(?=.)/, '')` — identical to `cost-calc.ts`.
- `mergeModelRows(rows)`: normalises each `modelId` before `parseModelId`; each `MergedModelRow` gains `ids: string[]`
  — the distinct normalised ids behind the row, in first-seen order. `rows` is unchanged (the caller still sums).
- `countModelIds(merged)`: Σ `ids.length`.

### 2. `frontend/src/pages/CostsPage.tsx`
- Rows come from `mergeModelRows(ov.byModel)` directly (no local `split('/').pop()`); the secondary line prints `g.ids`.
- "Models used" tile: value = merged models; definition = "<window> · N distinct ids — regional variants and
  inference-profile ARNs of one model merged", or "one id per model" when they coincide.
- Footer: "All time: $X across N models (M ids, counted the same way as the tile above) · …", both counts from
  `mergeModelRows(allTime.byModel)`.
- Acceptance: no id string appears twice within one row; for any window, `ids` on the tile ≤ `ids` in the footer and
  `models` on the tile ≤ `models` in the footer; totals row and tile dollars unchanged from before the fix.

## Out of scope
Backend; sorting; the sub-cent fold; other pages that use `mergeModelRows` (the added `ids` field is additive).
