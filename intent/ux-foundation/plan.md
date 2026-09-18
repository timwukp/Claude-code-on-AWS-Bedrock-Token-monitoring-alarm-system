# Plan: UX foundation (feature-20)

- **Spec:** ./spec.md
- **Author:** Claude (AI agent)
- **Accepted-by:** Tim WU
- **Accepted-for:** db018ea56d3de389b1d6249b42b594a786baf5fd
- **Status:** accepted

`Accepted-for` is the tip of `main` after PR #45 (feature-19), the merge base at PR time. The chain was
first accepted against `9274c7f`, then `37ae499`, and **re-accepted** here after 3-way merges onto each
new `main`; `Layout.tsx` and `styles.css` carry #43's `Kpi chip` prop and `.disclosure` block plus this
chain's rewrite. Merge queue agreed with the other active session: this chain (20) → their
`latency-observability` (18) → `global-time-range` (21) → `overview-page` (22) → `roi-cost-tables` (23)
→ `settings-and-format` (24); strictly serialized, one PR in flight at a time.

## Files changed

### New components and modules
1. `frontend/src/components/Icon.tsx` — hand-rolled inline SVG icon set (Lucide paths, ISC), 17 names,
   `aria-hidden` unless labelled. Replaces every emoji glyph in the shell.
2. `frontend/src/components/KpiTile.tsx` — the full tile anatomy (label, definition, value, delta with
   named comparison period, sparkline, status chip, info button, link, load/error/empty states).
3. `frontend/src/components/HelpPanel.tsx` — `HelpProvider`, `useHelp`, `HelpPanel` (right rail
   ≥ 1100 px, modal below; Esc; focus restore), `HelpButton`.
4. `frontend/src/components/EmptyState.tsx` — loading / empty / error with an action slot; no emoji.
5. `frontend/src/lib/help-content.ts` — the single `HELP` registry and `HelpId` union; seeded with one
   entry per existing KPI label on all seven pages.
6. `frontend/src/lib/model-names.ts` — `parseModelId` → family / friendly name / version / region;
   `mergeModelRows`. Consumed by `colorForModel` now and by the Cost table in PR4.
7. `frontend/src/charts/theme.ts` — validated series palette (dark + light), colour-per-entity map,
   grid/axis/tick/tooltip/legend props, mark specs.

### Modified
8. `frontend/src/styles.css` — token groups (type, space, surface, chart, status) with dark default and
   light set opt-in via `:root[data-theme="light"]` (not OS-driven — the product identity is dark); every existing rule rewritten on tokens; `.nav-group`, `.brand-mark`,
   `.kpi-*` anatomy classes, `.help-rail` / `.help-modal`, `.empty-state`, `.icon`; native controls
   inherit font; `:focus-visible` ring; `color-scheme`. Weight 650 retired.
9. `frontend/src/components/Layout.tsx` — grouped nav with `Icon`, wordmark, footer; mounts
   `HelpProvider` + `HelpPanel`; `Kpi` becomes a thin wrapper over `KpiTile` with its signature
   unchanged (`chip?: ReactNode` from #43 preserved); `Panel` gains optional `helpId`.
10. `frontend/src/auth/LoginGate.tsx` — the unstyled top-right `Sign out` and its `signOut` import are
    removed; the gate renders only its children once authenticated.
11. `frontend/src/main.tsx` — `Shell` reads the route via `useLocation`; `/usage` added as an alias of
    `/`; unknown paths redirect to `/`. No page component changes.
12. `frontend/src/pages/UsagePage.tsx` — the `AreaChart` adopts `charts/theme` (flat fills, solid
    hairline grid, theme ticks/tooltip, entity colours). Copy and numbers unchanged.

### Deleted
13. `frontend/src/components/StatCard.tsx` — dead code (zero importers). Deleted with a normal git
    push, since the file-upload commit path cannot delete.

Non-source riders: `.sdlc/active` (pointer handover from `roi-model-diagram`), `intent/ux-foundation/*`
(this chain), `docs/research-dashboard-ux.md` (the evidence), `CHANGELOG.md`, and
`docs/test-reports/feature-20-ux-foundation.md` plus its index row.

## Verification

- Gates before any push: frontend `tsc --noEmit` + `vite build`; backend `jest` + `tsc` (unchanged but
  CI runs them); `cdk synth --context env=ci`; SDLC gate dry-run with `--require-active`.
- Palette: `validate_palette.js` output for both modes recorded in the test report.
- Live (dev) after deploy: the authenticated Playwright audit (`/tmp/tums-audit/audit.mjs`) on all
  seven routes — zero console/page errors; `emoji` count 0 in the shell; one Sign out; `svg.icon` count
  ≥ 9 per page; the served bundle hash matches the build. Screenshots compared with the 2026-09-18
  baseline set for layout regressions on every page, in both colour schemes.
- Keyboard: Tab to an info button, Enter opens the panel, focus lands inside, Esc closes, focus returns.
- Contrast spot-check of `--text-dim` on `--surface` in both modes (≥ 4.5:1 at 12 px+).

## Risks

- **Dark theme touches every page through CSS alone.** Pages are not edited, so a rule that assumed
  white (`#fff`, `#f8fafc` literals in `styles.css`, inline `background` in pages) can leave a light
  island. Mitigation: grep for hex literals in `styles.css` and `pages/*.tsx` before the audit, and
  the seven-route screenshot pass in dark mode.
- **`Kpi` wrapper regressions.** Every page's cards render through the new tile; the wrapper maps
  `foot → definition` and keeps `chip`. Mitigation: the audit's `.kpi` counts per page must equal the
  baseline (4/4/3/4/3/6/8).
- **Rebase onto #43/#44/A.** `Layout.tsx` and `styles.css` conflict with #43 (the `Kpi chip` prop and
  `.disclosure` block are already preserved here, so the resolution is mechanical); `Accepted-for` is
  re-bound and the PR says so.
- **Emoji replacement is a judgement, not a cited rule** — the test report states this, as the intent
  does.
