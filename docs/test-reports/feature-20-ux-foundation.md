# Feature 20 — UX foundation (tokens, icons, tiles, help panel, dark theme)

- **Chain:** `intent/ux-foundation/` · **Branch:** `feat/ux-foundation` off `main@37ae499` (post-#44;
  to be rebased onto the post-#43 / post-feature-19 main before the PR opens) · **PR:** TBD
- **Origin:** the owner's verdict on the portal — "looks not professional, lacks guidance, hard to
  understand" — turned into twelve concrete defects by a deep-research run and an authenticated
  Playwright audit (`docs/research-dashboard-ux.md`). This chain owns the foundation: tokens, icons,
  the tile anatomy, the help panel, empty states, the chart theme and the dark plane. Four chains
  follow (time range · overview · ROI/Cost tables · settings/format).
- **Date:** 2026-09-18
- **Verdict:** PASS — gates, local authenticated render, CI (all six checks green) and the live dev
  validation below. qa raised one HIGH that this PR caused and fixed in a follow-up commit (see Live
  validation), and one LOW owned by feature-18.

## Three things this report has to say plainly

1. **Emoji were replaced for consistency, not because a rule forbids them.** Both research claims
   that Cloudscape's iconography guidance prohibits decorative/emoji icons were refuted (votes 1-2,
   0-3). The case rests on Carbon's restraint principle and on accessibility (emoji carry no
   accessible name and cannot follow state).
2. **Dark is the owner's preference on a question the research left open.** No surviving evidence
   favours dark or light for finance dashboards; observability tools default dark, cost tools light.
   The light set is kept as an explicit opt-in.
3. **The palette was validated, not eyeballed.** `validate_palette.js` (dataviz method) on the actual
   surfaces: dark 8-slot on `#111a2e` — all checks PASS (worst adjacent CVD ΔE 8.4, normal 19.3, all
   ≥ 3:1); light 8-slot on `#ffffff` — PASS with a contrast WARN on slots 3/4/5 (relief rule applies:
   direct labels or table view). The previous DORA human/AI pair `#2563eb`/`#6366f1` **FAILS**: normal
   ΔE 6.6 (floor 15), protan 1.9.

## Scope

| File | Change |
|---|---|
| `frontend/src/components/Icon.tsx` | new — 18 inline SVG glyphs (Lucide paths), `aria-hidden` unless labelled |
| `frontend/src/components/KpiTile.tsx` | new — label · definition · value · delta (named period, ▲▼ + `aria-label`) · sparkline · status chip · ⓘ · link · load/error/empty states |
| `frontend/src/components/HelpPanel.tsx` | new — `HelpProvider` / `useHelp` / `HelpPanel` (rail ≥ 1100 px, modal below with focus trap; Esc; focus restore) / `HelpButton` |
| `frontend/src/components/EmptyState.tsx` | new — loading / empty / error, action slot, no emoji |
| `frontend/src/lib/help-content.ts` | new — `HELP` registry (28 entries, every KPI on all pages, canonical DORA labels) + `helpIdForLabel` |
| `frontend/src/lib/model-names.ts` | new — `parseModelId`, `mergeModelRows` |
| `frontend/src/charts/theme.ts` | new — validated palette (dark + light), colour-per-entity map, grid/axis/tick/tooltip/legend props, mark specs |
| `frontend/src/styles.css` | rewritten on tokens; dark default, `data-theme="light"` opt-in; `.kpi-*`, `.help-*`, `.empty-state`, Recharts chrome overrides; weight 650 retired; native controls inherit font |
| `frontend/src/components/Layout.tsx` | grouped nav with icons, wordmark, footer (the `timer` glyph is included for feature-18's Latency entry, which adds its own nav item together with its route); mounts help; `Kpi` → `KpiTile` wrapper with label→help bridge; `Panel` `helpId` |
| `frontend/src/auth/LoginGate.tsx` | stray unstyled `Sign out` removed |
| `frontend/src/main.tsx` | `useLocation`; `/usage` alias; `*` → `/` |
| `frontend/src/pages/UsagePage.tsx` | chart adopts the theme (flat fills, solid hairline grid, entity colours); KPI accents follow the same entities |
| `frontend/src/components/StatCard.tsx` | deleted (zero importers) |

No numbers, API or backend change.

## Unit tests and gates

| Gate | Result |
|---|---|
| Frontend `tsc --noEmit` | PASS |
| Frontend `vite build` | PASS |
| Backend `tsc --noEmit` / `jest` | unchanged files; run for CI parity — PASS (174/174) |
| `sdlc_ci_gate.py --require-active` | PASS — 12 source files, all named in `intent/ux-foundation/plan.md` |
| Palette validator | dark PASS · light PASS + WARN (see above) |

## Local authenticated render (pre-rebase, against the live dev API)

Playwright, 1440×900, owner's session, side-dir build:

| Route | `.kpi` | ⓘ attached | shell emoji | `svg.icon` | result |
|---|---|---|---|---|---|
| `/` Usage | 4 | 4 | 0 | 14 | OK |
| `/costs` | 4 | 4 | 0 | 14 | OK |
| `/governance` | 4 | 4 | 0 | 14 | OK |
| `/anomalies` | 3 | 3 | 0 | 13 | OK |
| `/projects` | 3 | 3 | 0 | 13 | OK |
| `/roi` | 8 | 0 (labels are project names) | 0 | 10 | OK |
| `/usage` alias · `/nope` → `/` | — | — | — | — | OK |
| `/dora` | — | — | — | — | **crash — not this branch**: pre-#43 `DoraPage.tsx` reads `changeFailureRate` against the deployed #43 API (`changeFailRate`). Disappears on rebase onto post-#43 main; re-verified there before push. |

Keyboard: Tab to an ⓘ, Enter → panel opens (`role="dialog"`), focus lands inside, Esc → closes,
focus returns to the ⓘ. Verified programmatically. Rail at 1440 px; modal with backdrop at 900 px.

## Live validation (dev)

- PR #46's qa run synced this branch's build to dev — served bundle `index-DK7unYvX.js`. Authenticated
  Playwright pass (owner's session, 1440×900) on the served site: all seven routes 0 console/page
  errors; `.kpi` counts 4/4/4/3/6/8/3 (Usage/Costs/Governance/Anomalies/DORA/ROI/Projects) equal the
  baseline; shell emoji 0; ⓘ present on 24 tiles (0 on ROI, whose labels are project names); keyboard
  flow verified live (Enter opens, focus inside, Esc closes, focus returns).
- CI qa (8 pages, login PASS, 0 console errors, 0 failed requests; cross-page totals reconcile; earlier
  findings F-1001 and F-201 confirmed fixed/holding; the #44 DORA crash not reproduced) raised:
  - **F-1401 HIGH — caused by this PR, fixed here:** the nav carried a `Latency` entry ahead of the
    route that feature-18 adds, so it redirected to `/`. The entry is removed in the follow-up commit;
    feature-18 adds nav item and route together. The `timer` glyph stays for it.
  - **F-1402 LOW — not this PR's:** `fmtTokens` prints `1260.91M` / `16298.32M` without separators
    (recurrence of F-1201). `format.ts` is deliberately outside this chain; feature-18 owns the fix.

## Accessibility

- Icons `aria-hidden` unless labelled; ⓘ buttons `aria-label="About {label}"`; delta carries a spoken
  `aria-label`; status chips are icon + text; help panel is `role="dialog"` with `aria-labelledby`,
  modal variant `aria-modal` + focus trap; `:focus-visible` ring everywhere; native controls inherit
  the app font.
- `--text-dim #94a3b8` on `--surface #111a2e`: ≈ 6.9:1.

## Leak scan

`grep -nE '[0-9]{12}|AKIA|arn:aws'` over every file in this PR: no matches.
