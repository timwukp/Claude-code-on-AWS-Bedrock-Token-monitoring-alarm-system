# Plan: Full-view freshness copy (mini chain)

- **Spec:** ./spec.md
- **Author:** Claude (AI agent)
- **Accepted-by:** Tim WU
- **Accepted-for:** c0361f2727d825be723c95758136e9513e8665a5
- **Status:** accepted

`Accepted-for` is the tip of `main` after PRs #75 and #76. Nothing else is in flight; lakehouse P1 starts after this.

## Files changed
1. `backend/lambdas/api/invocation-source.ts` — `day()`.
2. `backend/lambdas/api/invocation-source.test.ts` — `day()` cases.
3. `backend/lambdas/api/queries.ts` — `byProject` all-time + `data_through`.
4. `backend/lambdas/api/queries.test.ts` — pruning split; `data_through` position.
5. `frontend/src/pages/ProjectsPage.tsx` — freshness copy; `fullThrough` state and chip.
6. `frontend/src/lib/help-content.ts` — `project.source`.

Non-source riders: `.sdlc/active` (handover from `unpriced-visibility-and-churn`), `intent/unpriced-visibility-and-churn/*`
→ shipped, `intent/full-view-freshness-copy/*`, `CHANGELOG.md`, `docs/test-reports/README.md` (row + live results for
feature-42/43), `docs/test-reports/feature-42-*.md` and `feature-43-*.md` (live sections filled from the 2026-10-26 deploy).

## Verification
- backend jest (426) + tsc; frontend tsc + build; SDLC gate.
- After the owner's Api + frontend deploy: Full view chip reads "curated Parquet through <yesterday/today>", the cost
  footer explains the gap in the new direction, totals are all-time again.
