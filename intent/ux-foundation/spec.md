# Spec: UX foundation — tokens, icons, tiles, help panel, empty states, chart theme, dark theme

- **Intent:** ./intent.md
- **Author:** Claude (AI agent)
- **Accepted-by:** Tim WU
- **Status:** signed-off

## Behaviour

### 1. Design tokens (`styles.css` `:root`)

| Group | Tokens | Rule |
|---|---|---|
| Type | `--fs-xs 11 · --fs-sm 12 · --fs-base 13 · --fs-md 14 · --fs-lg 16 · --fs-xl 18 · --fs-kpi 28`; `--fw-regular 400 · --fw-medium 500 · --fw-semibold 600 · --fw-bold 700` | No other size or weight anywhere in the stylesheet; weight 650 is retired. |
| Space | `--sp-1 4 · --sp-2 8 · --sp-3 12 · --sp-4 16 · --sp-5 24 · --sp-6 32` | Padding/gap/margin in components use these. |
| Surface | `--bg`, `--surface`, `--surface-2`, `--border`, `--text`, `--text-dim`, `--primary`, `--primary-weak`, `--sidebar-*` | Two value sets (below). |
| Chart | `--chart-grid`, `--chart-axis`, `--chart-tick`, `--series-1..8`, `--series-muted`, `--diverge-pos/neg/mid` | Mirrored as literals in `charts/theme.ts`. |
| Status | `--status-ok/warn/serious/danger` | Fixed across themes; never used as a series colour. |

Theme values:

| Token | Dark (default) | Light (opt-in `:root[data-theme="light"]`) |
|---|---|---|
| `--bg` | `#0b1220` | `#f8fafc` |
| `--surface` | `#111a2e` | `#ffffff` |
| `--surface-2` | `#16213a` | `#f8fafc` |
| `--border` | `rgba(255,255,255,0.08)` | `#e2e8f0` |
| `--text` / `--text-dim` | `#e6edf7` / `#94a3b8` | `#0f172a` / `#64748b` |
| `--primary` / `--primary-weak` | `#818cf8` / `rgba(99,102,241,0.18)` | `#6366f1` / `#eef2ff` |
| `--chart-grid` / `--chart-axis` / `--chart-tick` | `#1e293b` / `#273449` / `#94a3b8` | `#eef2f7` / `#e2e8f0` / `#64748b` |
| `--series-1..8` | `#3987e5 #d95926 #199e70 #c98500 #d55181 #008300 #9085e9 #e66767` | `#2a78d6 #eb6834 #1baf7a #eda100 #e87ba4 #008300 #4a3aa7 #e34948` |
| `--series-muted` | `#475569` | `#94a3b8` |
| `--diverge-pos` / `-neg` / `-mid` | `#3987e5` / `#e66767` / `#383835` | `#2a78d6` / `#e34948` / `#f0efec` |
| badge backgrounds | `color-mix(in srgb, <status> 16%, transparent)` | pastel steps as today |

Both palettes were validated with the dataviz `validate_palette.js` against their surfaces: dark
passes every check; light passes with a contrast WARN on slots 3, 4, 5 (relief rule: direct label or
table view whenever those slots carry a series).

Native `button, input, select, textarea` inherit `font`; `:focus-visible` shows a 2 px `--primary`
ring; `color-scheme` is declared so scrollbars and form controls follow the theme.

### 2. Icons (`components/Icon.tsx`)

`Icon({ name, size = 16, label?, className? })`. Inline SVG, 24-unit grid, stroke `currentColor`,
width 2, round joins. Without `label` → `aria-hidden="true"`; with `label` → `role="img"` +
`aria-label`. Names: `overview usage cost project shield bell rocket trend settings user logout info
close external chevron check alert`. No icon library dependency.

### 3. Shell (`components/Layout.tsx`, `auth/LoginGate.tsx`)

- Sidebar: wordmark (`TM` mark + "TokenMonitor"); `<nav aria-label="Primary">` with three groups
  and headings **Spend** (Usage, Cost, By project) · **Governance** (Budgets & guardrails, Anomalies)
  · **Delivery** (DORA metrics, AI ROI); each link = icon + label; active link keeps the indigo
  block. Footer: user (icon + truncated email), one `Sign out` (icon + text).
- `LoginGate` renders only its children once authenticated — the top-right button is removed.
- `Layout` mounts `HelpProvider` and `HelpPanel` so any descendant can open help.

### 4. KPI tile (`components/KpiTile.tsx`; `Kpi` in `Layout.tsx` becomes a wrapper)

```
KpiTile({
  label, value,
  definition?,                                    // one line under the value
  delta?: { value, unit: 'pct'|'usd'|'abs', compareLabel, goodDirection?: 'up'|'down'|'neutral' },
  sparkline?: number[],                           // 12-point, axis-less
  status?: { tone: 'ok'|'warn'|'serious'|'danger'|'info'|'neutral', text },
  helpId?, link?: { to, label? },
  state?: 'ready'|'loading'|'error'|'empty', stateText?, accent?, chip?
})
```
- Value uses proportional figures (no `tabular-nums`); `--fs-kpi` / `--fw-bold`.
- Delta renders ▲/▼ + signed text + `compareLabel` ("vs prior 30 days"); colour = direction ×
  `goodDirection`; `aria-label` spells it out ("up 12 % vs prior 30 days").
- Info button: `<button aria-label="About {label}">` with the `info` icon; opens `helpId`.
- Status chip = icon + text, never colour alone.
- `Kpi({ label, value, accent?, chip?, foot? })` keeps its exact signature and maps `foot →
  definition`, `chip → chip`, so no page changes in this chain.

### 5. Help panel (`components/HelpPanel.tsx`, `lib/help-content.ts`)

- Registry `HELP: Record<HelpId, HelpEntry>`; `HelpEntry = { title, what, why, how, caveats?:
  string[], docs?: { label, href } }`. `HelpId` is a string-literal union. Seeded with one entry per
  existing KPI label across all seven pages, content lifted from today's captions and caveat
  paragraphs (moving them is PR2–PR5's job; the registry must be able to receive them).
- `HelpProvider` context: `open(id, runtime?: { notes?: string[] })`, `close()`, `current`.
- `HelpPanel`: `<aside role="dialog" aria-modal aria-labelledby>`; ≥ 1100 px viewport → a 360 px
  right rail that does not trap focus; below → modal with focus trap. Esc closes; focus returns to
  the opener. Sections in order: *What is this · Why it matters · How it's calculated · Caveats ·
  Learn more*.
- `HelpButton({ id, label })` is the reusable info button.

### 6. Empty state (`components/EmptyState.tsx`)

`EmptyState({ kind: 'loading'|'empty'|'error', title, detail?, action?: { label, to?, onClick? },
icon? })`. Loading shows the spinner and `title`; error shows the `alert` icon; empty shows the
named icon. Never an emoji. Pages adopt it as they are touched (PR2+); this chain ships the component.

### 7. Chart theme (`charts/theme.ts`) and the Usage chart

Exports `gridProps`, `xAxisProps`, `yAxisProps(fmt)`, `tooltipProps`, `legendProps`, `SERIES`
(8 hex, dark + light, chosen by `matchMedia`), `MODEL_COLORS`, `colorForModel(id)`, `MARK` (`bar:
{ maxBarSize: 24, radius: [4,4,0,0] }`, `line: { strokeWidth: 2 }`, `area: { fillOpacity: 0.10 }`,
`dot: { r: 4 }`).

Colour follows the entity, never the rank: Claude Opus → slot 1, Sonnet → 3, Haiku → 4, Fable → 7,
Amazon Nova → 2, OpenAI → 5, others → 6/8 then `--series-muted` "Other". DORA human → 1,
AI-assisted → 2. Usage input → 1, output → 3, cache → 7.

`UsagePage.tsx`'s `AreaChart` adopts the theme in this chain: gradients removed (flat 10 % fill),
grid solid hairline, Y axis line off, ticks from the theme, legend kept (two series). No other page
is modified here; `DoraPage.tsx` and `RoiPage.tsx` adopt the theme in PR2 after #43 has landed.

### 8. Removal

`components/StatCard.tsx` is deleted (no importers).

## Out of scope

Routes, Overview, Settings, the time-range picker, ROI/Cost table rework, `format.ts`, any backend
or infra file, any change to a displayed number.
