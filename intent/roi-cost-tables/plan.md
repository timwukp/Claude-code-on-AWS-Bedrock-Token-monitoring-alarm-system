# Plan: ROI and Cost tables (feature-24)

- **Spec:** ./spec.md
- **Author:** Claude (AI agent)
- **Accepted-by:** Tim WU
- **Accepted-for:** 7c67e8bc9b1089acdb3b5d432d61053fd6586601
- **Status:** accepted

`Accepted-for` is the tip of `main` after PR #51 (feature-23), the merge base at branch time. The other
session's #53 (`fix/latency-profile-labels`) is in flight; whichever lands second takes the `.sdlc/active` /
CHANGELOG / index merge.

## Files changed
1. `frontend/src/pages/RoiPage.tsx` — URL-synced selection; sortable projects table; one detail panel replaces the per-project panels.
2. `frontend/src/pages/CostsPage.tsx` — merged model rows, friendly names + raw ids, sortable headers, zero-cost toggle, totals row, footer.
3. `frontend/src/pages/AnomaliesPage.tsx` — empty-state action at the 90-day window.
4. `frontend/src/styles.css` — sortable header, selectable row, totals row, model cell styles.

Non-source riders: `.sdlc/active` (handover from `overview-page`), `intent/overview-page/*` → shipped (my
own predecessor), `intent/roi-cost-tables/*`, `CHANGELOG.md`, `docs/test-reports/feature-24-roi-cost-tables.md`
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
