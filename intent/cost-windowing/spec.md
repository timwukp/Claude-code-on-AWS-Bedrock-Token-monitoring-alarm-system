# Spec: Cost page windowing

- **Intent:** ./intent.md
- **Author:** Claude (AI agent)
- **Accepted-by:** Tim WU
- **Status:** shipped

## Behaviour

### 1. `GET /v1/overview` — additive field
`byModel[]` rows gain `cacheSavingsUsd` (rounded to 2 dp): what the window's cache-read tokens would have
cost at the full input rate minus what they cost at the cache-read rate, from `computeModelCost`. Nothing
else in the response changes. Frontends built before this field exists keep working.

### 2. `pages/CostsPage.tsx`
- Uses `useTimeRange([7, 30, 90, 'mtd'])`; `PAGE_META['/costs'].windows` lists the same four (the picker
  appears; the fixed "All time" caption goes).
- Fetches `api.overview(window)` for the table and tiles, and `api.costs()` once for the footer.
- Tiles: **Estimated spend** = `spend.currentUsd` with a delta vs the prior equal period (`spend.deltaPct`,
  down is good) and the window label; **Saved by prompt caching** = Σ `byModel.cacheSavingsUsd` for the window
  (or "—" with "cache savings not available for this window until the API is redeployed" when the field is
  absent); **Models used** and **Cache-read tokens** for the window.
- Table: same columns, merged regional variants, `<$0.01` fold and totals row as today, sourced from
  `overview.byModel`. Cache-savings cells show `—` while the field is absent.
- Panel description names the window. Coverage caption when `coverage.partial`, as on Overview.
- Footer keeps: "All time: $X across N model ids · same rate card as By project and Overview" from `/v1/costs`.
- Empty state when the window has no priced usage; error/loading states unchanged.

### 3. `pages/OverviewPage.tsx`
Budget tile definition, whenever a number is shown: "… · AWS Budgets billed spend — not the token estimate
in the Spend tile". The existing no-billing-data and setup-required wordings stay.

### 4. `pages/AnomaliesPage.tsx`
Empty-state action is always "View budget guardrails"; the "Show last 90 days" shortcut is removed (the
disclosure beneath the feed lists older detections). No other change.

### 5. Help
`cost.estimated-spend` and `cost.cache-savings` entries say the figures follow the selected time range and
that the footer line is all-time.

## Out of scope
`/v1/costs`; rate card; Chart | Table toggles; DORA tables; an "all retained" window.
