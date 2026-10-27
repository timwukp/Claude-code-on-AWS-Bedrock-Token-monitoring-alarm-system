# Feature 44 — Full view freshness copy (mini chain after lakehouse P0)

- **Chain:** `intent/full-view-freshness-copy/` · **Branch:** `feat/full-view-freshness-copy` off `main@c0361f2` (#75 + #76) · **PR:** #77
- **Date:** 2026-10-27 · **Verdict:** PASS on gates; live check after the owner's Api + frontend deploy.

## What this report has to say plainly
- P0 changed where the Full view reads from; this chain changes what the page *says* about it. Found by the owner reading
  the live page after the 2026-10-26 deploy: the caption still claimed the Full view was live and ahead of the rollups.
- P0 also narrowed `byProject` to 90 days by giving every template a `dt` filter — an unintended semantic change on an
  all-time page. Reverted for this template only; the two windowed templates keep pruning.

## Scope
| File | Change |
|---|---|
| `backend/lambdas/api/invocation-source.ts` (+test) | `day()` |
| `backend/lambdas/api/queries.ts` (+test) | `byProject` all-time; trailing `data_through` = `MAX(MAX(l.dt)) OVER ()` |
| `frontend/src/pages/ProjectsPage.tsx` | `fullThrough` state; chip "athena · curated Parquet through <day>"; cost footer, caption, Projects-tracked footer rewritten |
| `frontend/src/lib/help-content.ts` | `project.source` |

## Gates
backend jest 426/426 · backend tsc · frontend tsc + build · SDLC gate PASS.

## Live — to fill after deploy
- Full view chip shows "through <day>"; totals all-time; footer explains the gap in the new direction.
