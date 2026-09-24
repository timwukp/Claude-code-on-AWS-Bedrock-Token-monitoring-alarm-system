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
| `frontend/src/lib/time-range.ts` | **qa F-PR59-001 (HIGH, pre-existing, found on this PR's first run):** Usage 30 d showed 20.61M / 13.67M input/output vs Cost 30 d 13.17M / 10.43M — the 7.44M gap is exactly the 08-25 bucket. The shared hook started at `now − 30×24h` (mid-day 08-25) so Usage's daily buckets covered 31 days; `/v1/overview` covers 30 calendar days from UTC midnight (08-26 → 09-24). `windowBounds` now starts at UTC midnight of `today − (N−1)`. Added to this plan so the fix ships with the PR that surfaced it |

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

## qa round 1 (`ca35fa3`) — F-PR59-001 and its fix, verified locally before the second push
| Check | Result |
|---|---|
| Root cause | `windowBounds(30)` started at `now − 30×24h` = mid-day 08-25; `/v1/usage` returns whole daily buckets, so Usage counted 31 days (08-25 → 09-24) while `/v1/overview` counted 30 (08-26 → 09-24). Gap 7.44M input = the 08-25 bucket exactly |
| New bounds (`tsx` check, now = 2026-09-24T13:10Z) | 7 → 09-18…09-24 (7 d) · 30 → 08-26…09-24 (30 d) · 90 → 06-27…09-24 · mtd → 09-01…09-24 (24 d) — identical to `overview-calc.windowBounds` |
| 7 d, Usage vs Cost | input **3.62M = 3.62M**, output **4.48M = 4.48M** |
| 30 d, Usage vs Cost | input 13.16M vs 13.17M (row rounding); output 10.28M vs 10.43M — see residual |
| MTD, Usage vs Cost | input 12.87M vs 12.88M; output 9.57M vs 9.72M — same residual |
| Console errors | 0 |

**Residual — a data difference, not a window one.** Day-by-day comparison of `/v1/usage` (hourly rollups) against the
PROJDAY items for the same tenant (DynamoDB query, 08-26 → 09-24, 15 days both sides): 14 days agree to the token;
**2026-09-17 differs — PROJDAY has +12,380 input and +146,311 output tokens more than the hourly rollups.** That is
the whole 30-day and MTD gap. It is an ingestion-side inconsistency for one day (the two rollups are written by the
same aggregator; one of them missed or re-processed a batch), outside this frontend chain — handed to the
ingestion owner (latency-per-project session) with these numbers. Until it is repaired, Cost and Usage disagree by
1.4% of output tokens on windows that include 09-17, and by nothing on windows that do not.

## Live (after push — qa)
_To be filled from the qa report on the PR._
