# Feature 29 — Chart | Table twin (every chart has a table view)

- **Chain:** `intent/chart-table-toggle/` · **Branch:** `feat/chart-table-toggle` off `main@0db85c5` (post-#62) · **PR:** TBD
- **Origin:** chart standard 6 ("Tooltip never gates") and the dataviz accessibility pass in
  `docs/research-dashboard-ux.md` — the one chart-standard item left open after features 20–27.
- **Date:** 2026-09-24
- **Verdict:** PASS on gates and the local authenticated render; live via qa recorded below.

## What this report has to say plainly
- **Every number a chart draws is now reachable as text.** Four panels (Usage consumption, DORA merges per week,
  DORA lead time per week, ROI components) gained a Chart | Table control; the table is the portal's standard
  `table.data`, formatted with the same `fmt*` helpers as the tiles, so a table figure equals the tooltip figure.
- **The chart is unmounted in table view** (0 `.recharts-wrapper` nodes while the table shows), so a screen-reader
  or print user does not pay for a drawing they cannot use; switching back re-mounts it.
- **`LatencyPage.tsx` is deliberately untouched** — the latency-per-project chain (feature-28) was changing it in
  parallel; its charts get the twin afterwards.

## Scope
| File | Change |
|---|---|
| `frontend/src/components/ChartTable.tsx` | new — segmented Chart \| Table control (`role="group"`, `aria-pressed`), `table.data` twin with `sr-only` caption |
| `frontend/src/styles.css` | `.chart-table-bar`, `.chart-table-data`, `.sr-only`, print rule hiding the control |
| `frontend/src/pages/UsagePage.tsx` | consumption chart wrapped — Day/Hour · Input · Output · Invocations |
| `frontend/src/pages/DoraPage.tsx` | merges-per-week (Week · Human-only · AI-assisted · Total) and lead-time (Week · Median lead time · Merged PRs) wrapped |
| `frontend/src/pages/RoiPage.tsx` | ROI components waterfall wrapped — Component · Side · Annual USD (signed) |
| `frontend/src/components/RoiModelDiagram.tsx` | owner-reported overlap on live `/roi`: provenance lines ran under the ROI result box and the Adoption-dip line was clipped at the right edge; provenance moved below the box, sentence wrapped, viewBox 470 → 506 |

## Gates
| Gate | Result |
|---|---|
| Frontend `tsc --noEmit` / `vite build` | PASS |
| `sdlc_ci_gate.py --require-active` | PASS — 5 source files, all named in the plan |

## Local authenticated render (build served on :4177, live dev API, owner's session)
| Check | Result |
|---|---|
| `/usage?window=30` | control "View Token consumption over time as"; Table: 16 rows (one per day with usage), headers Day · Input tokens · Output tokens · Invocations; first `08-25 7.45M 3.38M 8,895`, last `09-24 5.3k 76.1k 171`; chart nodes 1 → 0 → 1 across Chart → Table → Chart |
| `/dora?window=90` | two controls ("Merges per week", "Lead time per week"); 14 weekly rows each (W26–W39); lead-time gaps render `—` with `aria-label="no merges that week"`; chart unmounted in table view for both |
| `/roi?window=90` (project selected) | control "View Agent Terminal ROI components as"; 6 rows: `Time saved · Value · +$18,750` … `Adoption dip · Investment · −$5,625` — matches the waterfall's tooltip values |
| Keyboard | Tab from Chart to Table, Enter switches; `aria-pressed="true"` follows; table rendered (16 rows) |
| Console errors | 0 across all routes |

## Live (after push — qa)
_To be filled from the qa report on the PR._ This run is also the first qa pass under the #62 rule ("a page-disclosed,
quantified difference is not a finding"): record whether the `/projects` Full-vs-Fast disclosure was filed (it should
not be) and whether any real finding still was.

## Risks
- The Usage table can reach 336 rows for hourly buckets (≤ 14-day windows); the chart stays the default and the
  reader chooses the table.
