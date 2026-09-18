# Spec: global time range

- **Intent:** ./intent.md
- **Author:** Claude (AI agent)
- **Accepted-by:** Tim WU
- **Status:** shipped

## Behaviour

### 1. `lib/time-range.ts`
- `type Window = 7 | 30 | 90 | 'mtd'`; `ALL_WINDOWS`; `DEFAULT_WINDOW = 30`; `WINDOW_LABEL` ("Last 30
  days", "Month to date"); `WINDOW_SHORT` ("30d", "MTD").
- `parseWindow(raw)` → `Window | null`; `coerceWindow(requested, supported)` → nearest supported
  (7→30→90→mtd preference order per request); `windowBounds(w, now)` → `{ fromIso, toIso, days }`
  (mtd = UTC first of month → now).
- `useTimeRange(supported)` on `useSearchParams('window')` returns `{ window, requested, coercedFrom,
  days, fromIso, toIso, label, setWindow, supported }`. Bounds are anchored to the current **minute**
  so they are referentially stable across renders (a per-render `Date` would refire every fetch).
  `setWindow` writes the URL with `replace`.

### 2. `components/TimeRangePicker.tsx`
Segmented `role="group" aria-label="Time range"`; one button per `ALL_WINDOWS`, `aria-pressed` on the
active one, `disabled` + "(not available on this page)" in the `aria-label` for unsupported windows; a
caption underneath with the active label and, when coerced, "· <requested> not available here".
`supported = []` renders only `fixedCaption`.

### 3. Shell
`Layout` gains `windows?: readonly Window[]` and `fixedCaption?`; renders the picker at the right of
the top bar when `windows` is given. `main.tsx` `PAGE_META` declares per route: `/` and `/anomalies`
`[7,30,90,'mtd']`; `/dora` `[7,30,90]`; `/roi` `[30,90]`; `/costs` `[]` "All time · token-based
estimate"; `/projects` `[]` "All time · rollups"; `/governance` `[]` "Month to date · AWS Budgets period".

### 4. Pages
| Page | Change |
|---|---|
| Usage | `api.usage(fromIso, toIso)`; > 14 days → client-side daily buckets and `MM-DD` labels; KPI feet and chart description name the range; `EmptyState` for loading/error/empty (empty offers "Show last 90 days"); chart already on the theme. |
| DORA | window from the hook (`[7,30,90]`), local window segment removed, `?repo=` unchanged; bar chart human → `role('human')`, AI → `role('ai')`, 2 px surface gap, theme chrome; line chart theme chrome, series slot 3, no legend (single series). Disclosure unchanged. |
| ROI | window from the hook (`[30,90]`), local segment removed; caption keeps the "7-day ROI is deliberately unavailable" sentence with the live label; waterfall on the diverging pair (`positive` / `subtotal` / `negative`), 4 px radii; scatter on theme chrome, flagged → `negative`, others → slot 7, 2 px surface ring. |
| Anomalies | items filtered by `detectedAt >= fromIso` (sk prefix fallback); "Total alerts" foot names the range; panel description counts older detections outside the window; empty state = `check` icon + "No anomalies detected in the <range>" + action (widen to 90 days if older ones exist, else "View budget guardrails" → `/governance`); `EmptyState` for loading/error. |
| Governance | `EmptyState` for loading/error; period caption comes from the top bar. |

### 5. Styles
`.range-picker`, `.range-caption`, `.seg.seg-sm`, disabled segment style.

## Out of scope
API changes; Cost/Projects windowing (feature-22/23); numbers; the DORA disclosure; `format.ts`.
