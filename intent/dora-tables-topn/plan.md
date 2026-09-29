# Plan: DORA tables top-N (feature-33)

- **Spec:** ./spec.md
- **Author:** Claude (AI agent)
- **Accepted-by:** Tim WU
- **Accepted-for:** 7647a77f0cdb12d3cb0ac6a3d18ec3c5e5f0e094
- **Status:** accepted

`Accepted-for` is the tip of `main` after PR #65 (qa-empty-run-honesty), the merge base at branch time. Nothing else
is in flight.

## Files changed
1. `frontend/src/pages/DoraPage.tsx` — `useTopN` hook; ranked, cut views of the three tables with "Show all N" controls;
   captions name the ordering and the cut.

Non-source riders: `.sdlc/active` (handover from `qa-empty-run-honesty`), `intent/qa-empty-run-honesty/*` → shipped,
`intent/dora-tables-topn/*`, `CHANGELOG.md`, `docs/test-reports/feature-32-dora-tables-topn.md` plus its index row.

## Verification
- frontend `tsc --noEmit` + `vite build`; SDLC gate dry-run with `--require-active`.
- Local authenticated render of `/dora?window=90`: projects table shows 10 of 20 with "Show all 20"; clicking shows 20
  and the button reads "Show top 10 of 20"; repositories (8) and recent PRs (≤ 10 in the current data) show no
  button; first project row is the highest Est. USD; first repository row has the most merged PRs; page height drops;
  0 console errors.
- Live via qa after push (frontend path ⇒ qa runs).

## Risks
- A reader who scanned the whole projects table by eye now needs one click for rows 11–20; the caption says so.
