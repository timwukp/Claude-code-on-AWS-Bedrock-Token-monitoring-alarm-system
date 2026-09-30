# Feature 33 — DORA tables open on their top rows

- **Chain:** `intent/dora-tables-topn/` · **Branch:** `feat/dora-tables-topn` off `main@7647a77` (post-#65) · **PR:** #66
- **Origin:** table standards 4 ("default top 10 + Show all N") and 5 ("default sort by the value column") in
  `docs/research-dashboard-ux.md`; applied to Cost and ROI in features 24/27, never to DORA.
- **Date:** 2026-09-29
- **Verdict:** PASS on gates, the local authenticated render and qa (no finding on DORA; three LOWs elsewhere, each owned — below).

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

## Live — qa on `5999e8c` (sonnet-5-5 harness, #65 guard active)
| Check | Result |
|---|---|
| Overall | FAIL with **three LOWs — none on DORA or from this change**; 10/10 pages explored; the concurrency group cancelled the run for the first push so only one run exists |
| DORA tables | no finding |
| `/projects` disclosed $3.00 gap | NOT filed — the #62 rule holding |
| F-PR66-001 (LOW, Cost) | "Models used" tile at 90 d says 34 ids while the all-time footer says 28 model ids — a subset cannot exceed its superset, so the two counts use different id definitions (`/v1/overview.byModel` raw ids vs `/v1/costs.byModel`). **Feature-24/27 lineage — mine; follow-up chain** |
| `/roi` day-count (LOW) | monthly × 12 ≠ annual (30.44- vs 365/30-day bases) — latency-per-project owner's follow-up, already claimed |
| `/latency` by-model sum < fleet (LOW) | real cause found by the latency owner: 13 ModelId series now exist (the harness's own sonnet-5-5 / opus-5-5 calls appear in AWS/Bedrock metrics) and `latency.ts` slices to 12, dropping one; its earlier "burst lag" disclosure was wrong and qa rightly used the #62 escape clause. Fix: ranked top-N + explicit remainder row — theirs |

qa verdicts quoted:
```
**Target:** `https://d1vb50945w70c7.cloudfront.net/` · **Overall:** FAIL · **Auto-fix rounds:** 0
| LOW | /costs | Model-id counts contradict: the 90d window reports more model ids than the all-time footer. |
| LOW | /roi | Annualisation on the Token Usage Monitoring card does not reproduce from the displayed factor; monthly and yearly spend use different multipliers. |
| LOW | /latency | In the 7-day view, per-model invocation counts do not sum to the fleet total, and the page's stated cause does not fit the gap. |
{"overall":"FAIL","pages_tested":10,"findings":[{"id":"F-PR66-001","page":"/costs","severity":"LOW","summary":"Model-id counts contradict: the 90d window reports more model ids than the all-time footer.","evidence":"Cost page, 90d: 'Models used 21 · 34 ids — r
```

### Re-run on the same commit (5 findings, 1 FIXED)
Repeats escalated to MEDIUM (Cost id-count, `/roi` annualisation), a new HIGH on `/latency` vs `/usage` (fleet CloudWatch counts
are account-wide and now include the qa harness's own model calls; tenant-scoped Usage cannot match — latency owner's
chain, quantified note beside the numbers), and two new LOWs:
- **F-PR66-005 (LOW, `/dora`)** — sync banner "53 PRs collected" vs 54 merges in the 90-day window. Not this change and
  not frontend counting: the banner prints `DoraRepo.prCount`, a snapshot the collector writes into the registry item at
  sync time (`store.countItems()`), while the metrics count the live PR items on every read; the snapshot lags by the PRs
  stored after it was written. Backend (`dora.ts` / `collector.ts` / `store.ts`) — handed to the DORA store owner.
- **F-PR66-006 (LOW, `/costs`)** — a merged model row lists the same raw id twice: the ARN→id normalisation
  (`split('/').pop()`) maps `…inference-profile/us.anthropic.claude-opus-5` onto the genuine `us.anthropic.claude-opus-5`.
  Same code as F-PR66-001 — **mine, next chain `cost-id-consistency`** (dedupe normalised ids; count merged models the
  same way in the tile and the all-time footer).
The DORA tables themselves: still no finding.
