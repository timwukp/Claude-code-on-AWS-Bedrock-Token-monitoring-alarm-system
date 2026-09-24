# Plan: ROI model diagram layout fix (feature-19b)

- **Spec:** ./spec.md
- **Author:** Claude (AI agent)
- **Accepted-by:** Tim WU
- **Accepted-for:** 16da459f8a9f86cd28887746b186961ba3b9b95d
- **Status:** shipped

`Accepted-for` is the tip of `main` after PR #58 (feature-27 docs), the merge base at branch time. The
latency-per-project chain (feature-28) is staged by the other session but not yet pushed; the only files this
PR shares with it are the riders (`.sdlc/active`, `CHANGELOG.md`, `docs/test-reports/README.md`), which
whoever merges second resolves.

## Files changed
1. `frontend/src/components/RoiModelDiagram.tsx` — provenance lines relocated below the result box; Adoption-dip
   sentence wrapped to two lines; refusal note moved; viewBox height 470 → 506.
2. `frontend/src/lib/time-range.ts` — **added after qa on this PR (F-PR59-001, HIGH, pre-existing):** Usage's
   30-day input/output totals exceeded Cost's for the same range because the shared hook started its window at
   `now − N×24h` (mid-day) while `/v1/overview` uses N calendar days from UTC midnight; the extra partial day
   pulled a whole extra daily bucket into Usage. `windowBounds` now starts at UTC midnight of `today − (N−1)`,
   matching the server. Affects the two pages that filter client-side by `fromIso` (Usage, Anomalies); pages
   that pass `window=N` to the API are unchanged.

Non-source riders: `.sdlc/active` (handover from `cost-windowing`), `intent/cost-windowing/*` → shipped (my own
predecessor), `intent/roi-diagram-layout/*`, `CHANGELOG.md`, `docs/test-reports/feature-19b-roi-diagram-layout.md`
plus its index row.

## Verification
- frontend `tsc --noEmit` + `vite build`; SDLC gate dry-run with `--require-active`.
- Local authenticated render of `/roi`: measure every provenance `<text>` against the result `<rect>` — zero
  intersections; right edges inside the SVG; screenshot reviewed.
- Live via qa after push (qa redeploys the frontend to dev).

## Risks
- None beyond layout: the SVG is 36 units taller, so the "How to read this page" panel grows ~45 px at 1440 wide.
