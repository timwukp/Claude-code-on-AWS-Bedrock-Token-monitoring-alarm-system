# Feature 19b — ROI model diagram layout (footnotes no longer under the result box)

- **Chain:** `intent/roi-diagram-layout/` · **Branch:** `fix/roi-diagram-layout` off `main@16da459` (post-#58) · **PR:** #59
- **Origin:** owner's screenshot of the live `/roi` page, 2026-09-24: the ROI result box overlapping the
  "Adoption dip (J-curve …)" footnote, which was also clipped at the right edge.
- **Date:** 2026-09-24
- **Verdict:** PASS on gates and the local authenticated render; live via qa recorded below.

## What this report has to say plainly
- **A layout bug, not a data bug.** The result box (x 660–940, y 312–408) and the provenance lines (y 404–436,
  full width) were drawn over each other in the feature-19 SVG; the first provenance sentence was also wider than
  the 960-unit viewBox. Nothing the diagram says has changed.
- **Fixed by moving, not shrinking.** Provenance starts at y 430 (below the box), the long sentence wraps to two
  lines, the viewBox grows to 506. Legend swatches stay where they were — they never overlapped.

## Scope
| File | Change |
|---|---|
| `frontend/src/components/RoiModelDiagram.tsx` | provenance y 404/420/436 → 430/444/462/478 (sentence wrapped); refusal note y 452 → 494; viewBox 470 → 506 |

## Gates
| Gate | Result |
|---|---|
| Frontend `tsc --noEmit` / `vite build` | PASS |
| `sdlc_ci_gate.py --require-active` | PASS — 1 source file, named in the plan |

## Local authenticated render (build served on :4177, live dev API, owner's session, 1600 px wide)
| Check | Result |
|---|---|
| Result box vs footnotes | measured with `getBoundingClientRect`: none of the four provenance `<text>` nodes intersects the result `<rect>` (box bottom 772 px; first footnote top 787 px) |
| Right-edge overflow | widest line (Model skeleton) ends at 1431 px; SVG right edge 1471 px — inside |
| Adoption-dip sentence | two lines, both fully visible |
| Screenshot | `/tmp/tums-audit/local/f29-roi-diagram.png` reviewed — legend left, result box right, footnotes below |
| Console errors | 0 |

## Live (after push — qa)
_To be filled from the qa report on the PR._
