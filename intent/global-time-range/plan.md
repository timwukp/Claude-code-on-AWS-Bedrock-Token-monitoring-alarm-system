# Plan: global time range (feature-21)

- **Spec:** ./spec.md
- **Author:** Claude (AI agent)
- **Accepted-by:** Tim WU
- **Accepted-for:** 95e9ecab463f99448199fb8642318522cec0c8e9
- **Status:** accepted

`Accepted-for` is the tip of `main` after PR #47, the merge base at PR time (first accepted against `518553f`, re-accepted here). The agreed
queue puts the other session's `latency-observability` (feature-18) ahead of this chain; when it lands
this branch is rebased and `Accepted-for` re-bound — a re-acceptance, stated in the PR.

## Files changed

### New
1. `frontend/src/lib/time-range.ts` — window type, parse/coerce/bounds, `useTimeRange` (URL-synced, minute-anchored).
2. `frontend/src/components/TimeRangePicker.tsx` — the top-bar control and captions.

### Modified
3. `frontend/src/components/Layout.tsx` — `windows` / `fixedCaption` props; picker in the top bar.
4. `frontend/src/main.tsx` — per-route `windows` and `fixedCaption` in `PAGE_META`, passed to `Layout`.
5. `frontend/src/pages/UsagePage.tsx` — range-driven fetch, daily bucketing past 14 days, range-aware captions, `EmptyState`.
6. `frontend/src/pages/DoraPage.tsx` — window from the hook (local segment, `WINDOWS`, `parseWindow` removed); both charts on `charts/theme`.
7. `frontend/src/pages/RoiPage.tsx` — window from the hook (local segment removed); waterfall and scatter on `charts/theme`.
8. `frontend/src/pages/AnomaliesPage.tsx` — client-side window filter, older-count caption, actionable empty state, `EmptyState`.
9. `frontend/src/pages/GovernancePage.tsx` — `EmptyState` for loading/error.
10. `frontend/src/styles.css` — picker and caption rules.

Non-source riders: `.sdlc/active` (handover from `ux-foundation`), `intent/global-time-range/*`,
`CHANGELOG.md`, `docs/test-reports/feature-21-global-time-range.md` plus its index row. Predecessor
chains are left as they are on `main`.

## Verification
- Gates: frontend `tsc --noEmit` + `vite build`; SDLC gate dry-run `--require-active`.
- Local authenticated render: picker present on Usage/Anomalies/DORA/ROI, captions on Cost/Projects/
  Governance; `?window=90` honoured on Usage; `?window=mtd` on DORA coerces to 30 with the caption;
  `?window=7` on ROI coerces to 30 with the caption; clicking 90d updates the URL; zero console/page errors.
- Live (dev) after qa deploys the branch: same pass on the served site; recorded in the report.

## Risks
- **Fetch loop** if range bounds are not stable per render — mitigated by the minute anchor; the local
  Playwright pass waits for `networkidle`, which fails if the loop regresses.
- **Anomalies filter uses `detectedAt` or the `sk` prefix**; records with neither drop out of every window.
  Today all readable records carry `detectedAt`.
- **DORA URL compatibility**: the `?window=` key and its values are unchanged.
