# Feature 21 — Global time range (one control, URL-synced, every page states its period)

- **Chain:** `intent/global-time-range/` · **Branch:** `feat/global-time-range` off `main@518553f`
  (post-#46), rebased onto `95e9eca` (post-#47) · **PR:** TBD
- **Origin:** `docs/research-dashboard-ux.md` defect 6 — every page used a different time window with
  no shared control, so cross-page totals disagreed and each page explained why in prose.
- **Date:** 2026-09-18
- **Verdict:** PASS on gates and the local authenticated render; live validation recorded at queue turn.

## Two things this report has to say plainly

1. **Coercion is visible, never silent.** DORA cannot do month-to-date and ROI refuses 7 days (annualising
   one week is indefensible); asking for either shows the nearest supported window **and a caption saying
   which request was not honoured**. The URL keeps the reader's request, so navigating to a page that can
   honour it does.
2. **A real bug was caught by the test, not by review.** The first implementation derived `fromIso/toIso`
   from a fresh `Date()` on every render; Usage's fetch effect depended on those strings and refired on
   every render — an infinite request loop that the Playwright `networkidle` wait exposed as a timeout.
   Bounds are now anchored to the current minute. The wait-for-idle check stays in the verification so a
   regression fails the same way.

## Scope

| File | Change |
|---|---|
| `frontend/src/lib/time-range.ts` | new — `Window`, `parseWindow`, `coerceWindow`, `windowBounds`, `useTimeRange` (URL `?window=`, minute-anchored bounds) |
| `frontend/src/components/TimeRangePicker.tsx` | new — top-bar segmented control (`aria-pressed`, disabled + labelled unsupported windows) and captions |
| `frontend/src/components/Layout.tsx` | `windows` / `fixedCaption` props; picker in the top bar |
| `frontend/src/main.tsx` | per-route supported windows / fixed captions in `PAGE_META` |
| `frontend/src/pages/UsagePage.tsx` | range-driven fetch; daily buckets past 14 days; range-aware captions; `EmptyState` |
| `frontend/src/pages/DoraPage.tsx` | window from the hook, local control removed (`?repo=` unchanged); charts on the theme (human blue / AI orange, surface gap; single-series line without legend) |
| `frontend/src/pages/RoiPage.tsx` | window from the hook, local control removed; waterfall on the diverging pair; scatter on theme chrome |
| `frontend/src/pages/AnomaliesPage.tsx` | client-side window filter; older-count caption; actionable empty state |
| `frontend/src/pages/GovernancePage.tsx` | `EmptyState` for loading/error |
| `frontend/src/styles.css` | `.range-picker`, `.range-caption`, `.seg.seg-sm`, disabled segment |

No API or computed-value change.

## Unit tests and gates

| Gate | Result |
|---|---|
| Frontend `tsc --noEmit` | PASS |
| Frontend `vite build` | PASS |
| `sdlc_ci_gate.py --require-active` | PASS — 10 source files, all named in `intent/global-time-range/plan.md` |

## Local authenticated render (owner's session, 1440×900, live dev API)

| Route | Result |
|---|---|
| `/` | picker `30d` active, caption "Last 30 days", 4 KPIs, area series rendered |
| `/?window=90` | `90d` active, "Last 90 days", daily buckets |
| `/costs` · `/projects` · `/governance` | no picker; captions "All time · token-based estimate" / "All time · rollups" / "Month to date · AWS Budgets period" |
| `/anomalies?window=7` | `7d` active, "Last 7 days", feed filtered |
| `/dora?window=7` | `7d` active; KPIs read "2 merges to main · 7 days"; MTD disabled |
| `/dora?window=mtd` | coerced: `30d` active, caption "Last 30 days · month to date not available here" |
| `/roi?window=7` | coerced: `30d` active, caption "Last 30 days · last 7 days not available here" |
| click `90d` on `/` | URL becomes `?window=90`, caption updates |
| console / page errors | 0 across all of the above; every navigation reached `networkidle` |

## Live validation (dev)

_At queue turn:_ same pass against the served bundle after qa deploys the branch; served hash recorded here.

## Accessibility

Picker is a `role="group"` with `aria-label`, each button `aria-pressed`; unsupported windows are real
`disabled` buttons whose `aria-label` says why; the caption is `aria-live="polite"` so the coercion
notice is announced. Empty states use `role="status"` / `role="alert"`.

## Leak scan

`grep -nE '[0-9]{12}|AKIA|arn:aws'` over every file in this PR: no matches.
