# Plan: Cost page id consistency (feature-35)

- **Spec:** ./spec.md
- **Author:** Claude (AI agent)
- **Accepted-by:** Tim WU
- **Accepted-for:** 1ce47263ba2d5c16db8cea03aded32b907de9cd2
- **Status:** shipped

`Accepted-for` is bound at branch time to the tip of `main` after PR #67 (numbers-reconcile, feature-34) merges; this
chain waits for it so that nothing is in flight alongside. Built locally beforehand on `3c60f41`; the two source files
are outside #67's plan.

## Files changed
1. `frontend/src/lib/model-names.ts` — `normalizeModelId` (mirrors the API), `mergeModelRows` normalises and exposes distinct `ids`, `countModelIds`.
2. `frontend/src/pages/CostsPage.tsx` — rows/ids from the shared merge; tile and footer count models and ids the same way; footer wording.

Non-source riders: `.sdlc/active` (handover from `numbers-reconcile`), `intent/numbers-reconcile/*` → shipped,
`intent/cost-id-consistency/*`, `CHANGELOG.md`, `docs/test-reports/feature-35-cost-id-consistency.md` plus its index row.

## Verification
- frontend `tsc --noEmit` + `vite build`; SDLC gate dry-run with `--require-active`.
- Local authenticated render of `/costs` at 7 / 30 / 90 / mtd against the deployed API: no repeated id in any row; tile ids ≤
  footer ids and tile models ≤ footer models on every window; dollar totals identical to the pre-fix build for the same
  window (grouping already summed duplicates). Numbers are read after #67's rate-card repricing, which is the new baseline.
- Live via qa after push.

## Risks
- Other `mergeModelRows` callers (charts/theme colour lookup, Overview) see the additive `ids` field only; behaviour unchanged
  unless they passed ARN ids, in which case they now merge correctly too.
