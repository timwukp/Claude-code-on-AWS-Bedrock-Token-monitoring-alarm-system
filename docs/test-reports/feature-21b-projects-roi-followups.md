# Feature 21b — Projects / ROI follow-ups (F-1706 cent drift, F-1707 refusal scope)

- **Chain:** `intent/projects-roi-followups/` · **Branch:** `feat/projects-roi-followups` off
  `main@de81fb7` (post-#48) · **PR:** TBD
- **Origin:** qa findings F-1706 and F-1707, recurring on #45/#46/#48 because no chain owned them.
- **Date:** 2026-09-18
- **Verdict:** PASS on gates and local render; backend wording validated by unit test until the API can be
  deployed (after feature-18 restores `LatencyFn` to the tree).

## What this report has to say plainly
- **F-1703 and F-1704 are deliberately not here.** Both are product decisions the owner has not made
  (header semantics in the Athena view; whether Fast/Full divergence is accepted as documented). This
  chain fixes the two findings that need no decision.
- The ROI refusal wording is an **API string**; the unit test now asserts the new scope phrase. Until the
  API is redeployed, dev keeps the old sentence — that is expected and stated here.

## Scope
| File | Change |
|---|---|
| `frontend/src/pages/ProjectsPage.tsx` | cent-rounded row sum; `centDrift`; disclosure in the "Total est. cost" foot |
| `frontend/src/components/RoiModelDiagram.tsx` | `<title>` on clipped lines; full refusal sentence under the legend |
| `backend/lambdas/api/roi-calc.ts` | refusal names the project's linked repositories as the scope |
| `backend/lambdas/api/roi-calc.test.ts` | assertion follows the new wording |
| `backend/lambdas/api/roi.ts` | methodology `refuses` copy names the scope |

## Gates
| Gate | Result |
|---|---|
| Backend `tsc --noEmit` / `jest` | PASS — 178/178, 19 suites |
| Frontend `tsc --noEmit` / `vite build` | PASS |
| `sdlc_ci_gate.py --require-active` | PASS — 5 source files, all named in the plan |

## Local authenticated render (live dev API)
- `/projects` (Fast): foot reads "… rows are shown to the cent, so their sum ($14,247.49) can differ from
  this total by a few cents · rollups as of 14:04 UTC". Header unchanged.
- `/roi`: for a refused project the diagram prints "Why ROI is not computed here: …" under the legend
  (old API wording until redeploy); 0 console/page errors.

## Live validation (dev)
_At queue turn:_ qa deploys the frontend; API deploy after feature-18 lands; served bundle and the new
refusal sentence recorded here.

## Leak scan
`grep -nE '[0-9]{12}|AKIA|arn:aws'`: no matches.
