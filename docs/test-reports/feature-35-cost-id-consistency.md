# Feature 35 — Cost page id consistency

- **Chain:** `intent/cost-id-consistency/` · **Branch:** `feat/cost-id-consistency` off `main@1ce4726` (post-#67) · **PR:** TBD
- **Origin:** qa F-PR66-001 (MEDIUM, "34 ids" in the window vs "28 model ids" all-time), F-PR66-006 and F-PR67-001
  (LOW, a merged row lists the same id twice; "Models used 11 · 17 ids" counts the repeats — 15 distinct).
- **Date:** 2026-10-02
- **Verdict:** PASS on gates and the local authenticated render; live via qa recorded below.

## What this report has to say plainly
- **One defect, three findings.** The window rows (`/v1/overview.byModel`) carry inference-profile ARNs; the page
  shortened them with `split('/').pop()` but never de-duplicated against the bare id, so an ARN and the id it routes
  counted as two — in the row's id line and in the tile. The all-time footer came from `/v1/costs`, which the API
  normalises and merges, so the two counts could not agree.
- **Fixed where both views can share it.** `lib/model-names.ts` now applies the API's own `normalizeModelId` rule
  before grouping and exposes each merged row's distinct `ids`; `CostsPage` counts models and ids from that one
  function for the tile and the footer alike. **No dollar or token figure changes** — grouping by canonical model
  already summed the duplicate rows correctly; only the id listing and the counts were wrong.
- **Correction on the record.** In the feature-33 report I attributed the DORA "53 collected vs 56 merges" finding to
  a stale `prCount` snapshot. That was wrong: stored and live counts match on every repo; qa compared one repo's
  all-time count with a two-repo 30-day sum. #67 relabelled the banner; nothing in the store needed fixing.

## Scope
| File | Change |
|---|---|
| `frontend/src/lib/model-names.ts` | `normalizeModelId` (mirrors `cost-calc.ts`); `mergeModelRows` normalises before `parseModelId` and adds `ids: string[]` (distinct); `countModelIds` |
| `frontend/src/pages/CostsPage.tsx` | rows and id lines from the shared merge (local `split('/').pop()` removed); "Models used" definition counts distinct ids; footer "across N models (M ids, counted the same way as the tile above)" |

## Gates
| Gate | Result |
|---|---|
| Frontend `tsc --noEmit` / `vite build` | PASS |
| `sdlc_ci_gate.py --require-active` | PASS — 2 source files, named in the plan |

## Local render (build served on :4177, live dev API)
Reviewed by the owner in their own browser on 2026-10-05 against the live page: no id repeated in any row; tile and
footer counts consistent across 7 / 30 / 90 / mtd; dollar and token figures unchanged from live main. Owner's go: "ok 推".
Gates (`tsc`, `vite build`, SDLC gate) PASS as above.

## Live (after push — qa)
_To be filled from the qa report on the PR._
