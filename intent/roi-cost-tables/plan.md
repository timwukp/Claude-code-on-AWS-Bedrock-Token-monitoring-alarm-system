# Plan: ROI and Cost tables (feature-24)

- **Spec:** ./spec.md
- **Author:** Claude (AI agent)
- **Accepted-by:** Tim WU
- **Accepted-for:** 8693ff42cbde17ff17236029f0a7a085908efb13
- **Status:** shipped

`Accepted-for` is the tip of `main` after PR #53 — main was merged into this branch after #53 landed (a
re-acceptance; first accepted against `7c67e8b`).

## Files changed
1. `frontend/src/pages/RoiPage.tsx` — URL-synced selection; sortable projects table; one detail panel replaces the per-project panels.
2. `frontend/src/pages/CostsPage.tsx` — merged model rows, friendly names + raw ids, sortable headers, zero-cost toggle, totals row, footer.
3. `frontend/src/pages/AnomaliesPage.tsx` — empty-state action at the 90-day window.
4. `frontend/src/styles.css` — sortable header, selectable row, totals row, model cell styles.
5. `frontend/src/pages/OverviewPage.tsx` — **correction to feature-23** (qa F-PR53-102): `df.value` is merges per *day*; the
   Deployment-frequency tile summed daily rates and labelled them per week (≈7× under). Now × 7, matching `DoraPage.tsx`.

Non-source riders: `.sdlc/active` (handover from `latency-profile-labels`, which #53 shipped), `intent/latency-profile-labels/*` → shipped, `intent/overview-page/*` → shipped (my own predecessor), `intent/roi-cost-tables/*`, `CHANGELOG.md`, `docs/test-reports/feature-24-roi-cost-tables.md`
plus its index row.

## Verification
- frontend `tsc --noEmit` + `vite build`; SDLC gate dry-run.
- Local authenticated render: ROI page height 9 822 → ≈ 3 600 px; 10 rows; row click sets `?project=` and the
  detail panel follows; sort toggles; Cost 26 ids → 17 merged rows, 9 folded, totals row; Anomalies at 90 days
  offers the guardrails link; 0 console/page errors.
- Live via qa after push; recorded in the report.

## Risks
- `mergeModelRows` groups by canonical id after stripping the ARN prefix; an unfamiliar vendor falls back to a
  title-cased raw id (no data lost, only a less friendly label).
- Sorting the ROI column puts "not computable" rows last (sentinel −1e9) — intended.
