# Intent: the Cost page counts models and ids one way

- **Slug:** cost-id-consistency
- **Author:** Claude (AI agent)
- **Date:** 2026-09-30
- **Accepted-by:** Tim WU
- **Status:** accepted

## Problem

Three qa findings on the Cost page (F-PR66-001 MEDIUM, F-PR66-006 LOW, F-PR67-001) describe one defect: the page
has two definitions of "model id". The window view (`/v1/overview.byModel`) carries raw ids — including
inference-profile ARNs — which the page shortened with `split('/').pop()` and then counted and listed without
de-duplicating, so a merged row could read `us.anthropic.claude-fable-5 · global.anthropic.claude-fable-5 ·
us.anthropic.claude-fable-5`, the "Models used" tile said "34 ids", and the all-time footer (from `/v1/costs`, whose
ids the API already normalises and merges) said "28 model ids". A subset showing more ids than its superset is a
contradiction a reader cannot resolve, and the repeated id in a row looks like a bug because it is one.

## Evidence

`backend/lambdas/api/cost-calc.ts:normalizeModelId` strips the ARN prefix and merges duplicates before `/v1/costs`
responds; the frontend did neither for `/v1/overview` rows. Table standard 3 (friendly name first, raw ids as one
secondary line) assumes the id list is a set.

## Desired outcome

- `lib/model-names.ts` gains the same `normalizeModelId` rule as the API; `mergeModelRows` normalises before
  grouping and exposes `ids` as a distinct set; `countModelIds` gives the one "ids" figure.
- Cost: each merged row lists each id once; the "Models used" tile counts merged models and distinct ids; the
  all-time footer counts both the same way ("across N models (M ids, counted the same way as the tile above)").
- No number in dollars or tokens changes — grouping by canonical model already summed the duplicates correctly.

## Non-goals

- No backend change: `cost-calc.ts` already normalises; the defect was frontend-only. (Checked per the peer's
  note that the same rule lives there.)
- No change to which rows appear, to the `<$0.01` fold, or to sorting.
