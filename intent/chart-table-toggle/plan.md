# Plan: Chart | Table twin (feature-29)

- **Spec:** ./spec.md
- **Author:** Claude (AI agent)
- **Accepted-by:** Tim WU
- **Accepted-for:** 0db85c5b2974b1a273732128d06f593a537310a3
- **Status:** shipped

`Accepted-for` is the tip of `main` after PR #62 (projday-repair-qa-disclosure), the merge base at branch time.
Nothing else is in flight. The work was built earlier on `16da459` and re-based twice (over #59/#60 and #61/#62)
without content conflicts — only the three rider files moved.

## Files changed
1. `frontend/src/components/ChartTable.tsx` — new: segmented Chart | Table control, standard `table.data` twin with caption.
2. `frontend/src/styles.css` — `.chart-table-bar`, `.chart-table-data`, `.sr-only`, print rule.
3. `frontend/src/pages/UsagePage.tsx` — token-consumption chart wrapped; four-column table.
4. `frontend/src/pages/DoraPage.tsx` — merges-per-week and lead-time-per-week charts wrapped.
5. `frontend/src/pages/RoiPage.tsx` — ROI components waterfall wrapped.
6. `frontend/src/components/RoiModelDiagram.tsx` — layout fix reported by the owner on the live page: the provenance lines
   (Adoption dip, Model skeleton, Full method) sat at y 404–436 across the full width and ran under the ROI result box
   (x 660–940, y 312–408), with the Adoption-dip sentence also clipped at the right edge. They move below the result box
   (y 430–478), the Adoption-dip sentence wraps to two lines, and the viewBox grows 470 → 506.

Non-source riders: `.sdlc/active` (handover from `projday-repair-qa-disclosure`), `intent/projday-repair-qa-disclosure/*`
→ shipped, `intent/chart-table-toggle/*`, `CHANGELOG.md`, `docs/test-reports/feature-29-chart-table-toggle.md` plus its
index row.

## Verification
- frontend `tsc --noEmit` + `vite build`; SDLC gate dry-run with `--require-active`.
- Local authenticated render: each of the four panels shows the control; Table view lists the same number of rows as
  the chart has points/weeks/components; the first and last table values equal the chart's tooltip values; keyboard:
  Tab reaches both buttons, Enter/Space switches, `aria-pressed` follows; 0 console errors.
- Live via qa after push.

## Risks
- The Usage table can be long (hourly buckets ≤ 14 days ⇒ up to 336 rows): acceptable for a table view a reader chose;
  the chart remains the default.
