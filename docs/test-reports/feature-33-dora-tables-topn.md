# Feature 33 — DORA tables open on their top rows

- **Chain:** `intent/dora-tables-topn/` · **Branch:** `feat/dora-tables-topn` off `main@7647a77` (post-#65) · **PR:** TBD
- **Origin:** table standards 4 ("default top 10 + Show all N") and 5 ("default sort by the value column") in
  `docs/research-dashboard-ux.md`; applied to Cost and ROI in features 24/27, never to DORA.
- **Date:** 2026-09-29
- **Verdict:** PASS on gates and the local authenticated render; live via qa recorded below.

## What this report has to say plainly
- **Presentation only.** The three tables keep every row, column and figure; they open on the ten that matter most
  and grow on one click. Repositories are ranked by merged PRs and projects by estimated spend because those are the
  columns a reader scans them for; recent PRs stay newest first, which is what "recent" promised.
- **The caption says what happened.** Each panel description names the ordering and, when rows are hidden, how many
  are shown — the cut is never silent.

## Scope
| File | Change |
|---|---|
| `frontend/src/pages/DoraPage.tsx` | `useTopN` hook (cut + "Show all N" / "Show top 10 of N" control, `aria-expanded`); ranked views (`mergedPrs` desc, `estimatedUsd` desc) via `useMemo`; captions updated; hooks placed with the page state so React hook order is stable |

## Gates
| Gate | Result |
|---|---|
| Frontend `tsc --noEmit` / `vite build` | PASS |
| `sdlc_ci_gate.py --require-active` | PASS — 1 source file, named in the plan |

## Local authenticated render (build served on :4177 vs live main, `/dora?window=90`, owner's session, 1440 px)
| Check | Live (main, before) | feature-33 |
|---|---|---|
| Page height | 5,747 px | **4,396 px** default · 5,823 px with both tables expanded |
| Recent merged PRs | 25 rows | 10 rows + **"Show all 25"** (`aria-expanded=false`) → 25 rows + "Show top 10 of 25" (`true`); first row unchanged (#68, newest) |
| All tracked repositories | 6 rows, registry order | 6 rows, **no control** (≤ 10); first row `timwukp/agent-skills-best-practice` with 38 merged PRs — the most |
| Projects — delivery × cost | 21 rows, registry order | 10 rows + **"Show all 21"** → 21 + "Show top 10 of 21"; first row Agent Terminal at **$3,085.90** — the highest Est. USD |
| Captions | — | "… newest first · showing the newest 10" / "6 repositories, most merged PRs first — …" / "21 projects, highest estimated spend first — … · showing the top 10" |
| Cohort panel, KPI cards, charts | unchanged | unchanged |
| Console errors | 0 | 0 |

## Live (after push — qa)
_To be filled from the qa report on the PR._
