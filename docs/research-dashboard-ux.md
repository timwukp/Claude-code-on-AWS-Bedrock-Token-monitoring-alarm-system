# Research: making the portal read as a professional, self-explaining dashboard

Date: 2026-09-18. Method: (1) deep-research run `wf_315dab44-c70` — 108 agents, 25 sources
fetched, 125 claims extracted, 25 verified by 3-vote adversarial review, 23 confirmed, 2 refuted;
(2) live audit of the deployed dev portal (all 7 routes, 1440×900, authenticated session,
full-page screenshots + accessibility tree + computed styles). Screenshots are not committed.

## 1. What the live audit found

| Route | Height | Words | Charts | Tables | Verdict |
|---|---|---|---|---|---|
| `/` Usage | 1 337 px | 329 | 3 | 1 | Readable; thin KPIs; lands on a raw chart |
| `/costs` | 1 498 px | 231 | 0 | 1 (26 rows) | 15 of 26 rows are `$0.00` noise; raw model ids |
| `/projects` | 2 908 px | 721 | 0 | 2 | Monitoring table + admin CRUD on one page |
| `/governance` | 937 px | 166 | 0 | 1 | `$0.00 actual` next to `$1000 budget` reads as broken |
| `/anomalies` | 937 px | 71 | 0 | 0 | Three `0` tiles + emoji; empty state has no action |
| `/dora` | 6 429 px | 1 572 | 4 | 7 | Best fold in the app; 9 sections + admin form below it |
| `/roi` | 9 822 px | 2 794 | 19 | 0 | 18 near-identical per-project waterfalls, each "not computable" |

Concrete defects, in the order a first-time user meets them:

1. **No overview.** Landing page is the raw token chart. Nothing answers "how much are we
   spending, is it under control, did anything change" in one screen.
2. **Flat navigation.** Seven items under a single "Monitoring" header, no grouping
   (Spend / Delivery / Governance), no active-section context in the top bar. The top bar is
   otherwise empty except a browser-default-styled `Sign out` button (Arial, `#efefef`) that
   duplicates the one in the sidebar footer.
3. **Emoji as icons** in nav (📊 💰 🗂️ 🛡️ 🔔 🚀 📈), user chip (👤), empty state (✅) and brand (◆).
   Renders differently per OS, cannot be recoloured for active/disabled states, and no icon
   carries an accessible name. *Note: the research found no source that forbids emoji in
   enterprise UI — this is a consistency/brand judgement (Carbon's restraint rule), not a cited rule.*
4. **KPI tiles are label + value + caveat.** No delta vs prior period, no trend, no target, no
   freshness. The caveat line often runs to two or three lines ("reads + writes — quota counts
   these as input; billing discounts them").
5. **Inconsistent number formatting.** `$13875.10` and `$91856.10` (no thousands separator) beside
   `13,279` (with); `2880.00M`, `941.09M`, `15995.87M` (two decimals on compact notation). Same
   screen, three conventions.
6. **Inconsistent time windows with no global picker.** Usage = last 7 days; Cost = all-time;
   Projects = all-time; Governance = current month; DORA = 7/30/90 toggle; ROI = 30/90 toggle.
   Cross-page totals therefore disagree (`$13 875` estimated vs `$0.00` billed) and each page
   spends a paragraph explaining why.
7. **Caveat paragraphs on the card face.** Projects attribution precedence ≈ 90 words above the
   table; Usage quota footnote; Governance data-source note; ROI "How to read this page" box
   *plus* a per-project paragraph repeated 18 times. Honest, but it is the primary thing the eye
   lands on, ahead of the numbers.
8. **Raw model identifiers** (`us.anthropic.claude-fable-5`, `global.anthropic.claude-opus-5`)
   in monospace as the row label; the same model appears under `us.` / `global.` / bare prefixes as
   separate rows (the PR #28 QA finding is still visible).
9. **Admin CRUD inside monitoring pages.** `Manage projects` (22 rows × Edit/Remove) and
   `Manage tracked repositories` sit at the bottom of the Projects and DORA pages. Red `Remove`
   buttons are inline on every row.
10. **Hover-only tooltips**: 29 `title=` attributes on DORA, 7 on Usage; 5 `aria-label`s in the
    whole app. Definitions live in a collapsed drawer at the very bottom of a 6 400 px page.
11. **Empty states without a path.** Anomalies shows three zeros and "All clear" — no link to the
    detector config, thresholds or history. Governance shows `$0.00` without saying "this account
    has no direct billing" as a state.
12. **Typography drift.** 9 font sizes (11–28 px), 5 weights including a non-standard 650, 3
    families (Inter, SF Mono, and Arial leaking from unstyled native controls).

What already works and should be kept: the light slate palette (`#f8fafc` / `#0f172a` /
`#64748b`) is restrained and consistent; card radius and shadow are uniform; the DORA fold
(Throughput / Stability groups, qualifier chips, one-line provenance) is the design the rest of
the app should converge on.

## 2. What the research verified (3-0 unless noted)

| # | Finding | Sources |
|---|---|---|
| R1 | An **Overview** page should be the default landing and first nav link: 3–5 headline KPIs then "what changed". AWS Billing home, Vantage Overview, Cloudscape service-dashboard and Carbon all do this. | [AWS](https://docs.aws.amazon.com/cost-management/latest/userguide/view-billing-dashboard.html) · [Vantage](https://docs.vantage.sh/overview) · [Cloudscape](https://cloudscape.design/patterns/general/service-dashboard/) · [Carbon](https://carbondesignsystem.com/data-visualization/dashboards/) |
| R2 | A **KPI tile** = label + one-line definition + value + like-for-like delta with trend indicator + forecast where applicable + three-state status (OK / breached n ⚠ / Setup required) + info link + optional "View all". Comparison on by default, **comparison range labelled**. | [AWS](https://docs.aws.amazon.com/cost-management/latest/userguide/view-billing-dashboard.html) · [Vantage](https://docs.vantage.sh/cost_reports) · [Cloudscape dashboard items](https://cloudscape.design/patterns/general/service-dashboard/dashboard-items/) |
| R3 | "Enterprise-grade" = **hierarchy, restraint, consistency**: most important metric gets most contrast and area; limit metrics per view; same colour per model everywhere; same layout, spacing, legend position, units on every chart. | [Carbon](https://carbondesignsystem.com/data-visualization/dashboards/) · [NN/g](https://www.nngroup.com/articles/progressive-disclosure/) |
| R4 | **No front-loaded onboarding tour** as the primary guide (NN/g n=70: skipped, unmemorable, no task gain). Use contextual progressive disclosure: visible one-line definition → info link → **help panel** answering *What is this? Why do I care? How do I decide?* (incl. how it is calculated) → docs. | [NN/g tutorials](https://www.nngroup.com/articles/onboarding-tutorials/) · [Cloudscape help system](https://cloudscape.design/patterns/general/help-system/) · [Cloudscape help panel](https://cloudscape.design/components/help-panel/) |
| R5 | **Hover tooltips must never be the only carrier** of a definition; anything on hover must also trigger on focus and work on touch. | [NN/g](https://www.nngroup.com/articles/tooltip-guidelines/) · [WCAG 2.2 SC 1.4.13](https://www.w3.org/WAI/WCAG22/Understanding/content-on-hover-or-focus.html) |
| R6 | Every panel needs an **empty state** that states status + offers a direct action (create budget, connect repo, change range, load demo). Loading and error follow the same rule. | [NN/g](https://www.nngroup.com/articles/empty-state-interface-design/) · [Cloudscape](https://cloudscape.design/patterns/general/empty-states/) |
| R7 (medium — single source) | State **freshness and reconciliation** beside the numbers: "Last updated / refreshed every N", lag note, "why this differs from your AWS bill" with a link. | [AWS](https://docs.aws.amazon.com/cost-management/latest/userguide/view-billing-dashboard.html) |

Refuted (do not cite): two claims that Cloudscape's iconography page prohibits decorative/emoji
icons beside headings and nav (1-2 and 0-3). No surviving evidence on: typography scale, dark vs
light for finance, colour-blind palettes / WCAG contrast numbers, currency formatting, time-range
picker conventions, DORA proxy-metric presentation, or the Cloudscape-vs-custom-CSS trade-off.
Those items below are marked *judgement*.

## 3. Recommendations, prioritised

### Tier A — quick wins (each ≤ 1 day, no new routes, no API change)

| | Change | Fixes | Basis |
|---|---|---|---|
| A1 | One `formatCurrency` / `formatCompact` in `frontend/src/lib/format.ts`, used everywhere: `$13,875.10`, `941M`, `2.9B`, `13,279`. Never two decimals on compact units. | audit 5 | R3 |
| A2 | Replace emoji with an SVG icon set (Lucide or Cloudscape icons, 16 px, `currentColor`, `aria-hidden` + text label). Replace `◆` with a simple wordmark. | audit 3 | judgement + R3 |
| A3 | Remove the duplicate top-bar `Sign out`; give the top bar a job: page title + global time-range picker + "Data as of HH:MM UTC · refreshes every 15 min" + help toggle. | audit 2, 6, 11 | R7, R2 |
| A4 | Cost table: friendly model names (`Claude Opus 5`) as the label with the raw id in a secondary line; collapse `us.` / `global.` / bare variants into one row with a region chip; hide `< $0.01` rows behind "Show 15 zero-cost models". | audit 8 | R3 |
| A5 | Move every multi-sentence caveat off the card face into the help panel (see B2); leave **one** line on the face. Coverage / "not collected" chips stay on the face (they already do on DORA). | audit 7 | R4, R5 |
| A6 | Empty states with actions: Anomalies → "No anomalies in the last 30 days · [View detector settings] [See history]"; Governance `$0.00` → status "No direct billing on this account · [How billing is read]". | audit 11 | R6 |
| A7 | Typography tokens: 4 sizes (12 / 14 / 16 / 28), 3 weights (400 / 500 / 650→600), one family; style native buttons. | audit 12 | R3 |

### Tier B — medium (2–5 days each)

| | Change | Fixes | Basis |
|---|---|---|---|
| B1 | **`KpiTile` component** replacing `StatCard`: label, one-line definition, value, delta vs the prior equal window with ▲▼ and the compared range in small text, optional sparkline, optional status chip, `ⓘ` opening the help panel, optional "View all →". All seven pages adopt it. | audit 4 | R2 |
| B2 | **Help panel** (right-hand drawer, Cloudscape pattern): keyed by metric id; content = *What is this / Why it matters / How it is calculated / Caveats / Link to docs*. Opened from `ⓘ` on tiles and section headers; keyboard-focusable; replaces the 36 `title=` tooltips. | audit 7, 10 | R4, R5 |
| B3 | **Global time-range picker** in the top bar (7 / 30 / 90 days, month-to-date) driving Usage, Cost, Projects, DORA, ROI; each page shows the range it is displaying. Governance stays month-to-date and says so. | audit 6 | R2 |
| B4 | **Split admin from monitoring**: `Manage projects` and `Manage tracked repositories` move to a `/settings` route (admin-only), reached from the sidebar footer. Projects and DORA pages shrink by ~40 %. | audit 9 | R3 |
| B5 | **ROI page**: replace 18 stacked waterfalls with one sortable table (project · monthly spend · break-even h/mo · evidence bracket · ROI or "not computable — why") and a single detail waterfall for the selected row. Keep "How to read this page" as a collapsed help entry. | audit table row 7 | R3 |
| B6 | Shared **Recharts theme** module: one colour per model across Usage/Cost/Projects/DORA, fixed legend position, axis font from tokens, compact tick formatter from A1. | audit 5 | R3 |

### Tier C — larger (1–2 weeks)

| | Change | Fixes | Basis |
|---|---|---|---|
| C1 | **Overview page** as `/` and first nav item: four `KpiTile`s (Spend MTD + delta + forecast · Budget status · Anomalies 30 d · Deployment frequency headline), a "What changed this week" list (top movers by model and project), and links into each section. Usage moves to `/usage`. | audit 1 | R1, R2 |
| C2 | **Nav regrouping** with section headers: *Spend* (Overview, Usage, Cost, By Project) · *Governance* (Budgets & guardrails, Anomalies) · *Delivery* (DORA, ROI) · footer: Settings, user, sign out. | audit 2 | R1 |
| C3 | Accessibility pass to WCAG 2.2 AA: contrast check on `#64748b` small text against white, focus rings, `aria-label` on icon-only controls, tables with `scope`, live regions for refresh. | audit 10 | R5 |

### Design-system decision (judgement — not resolved by evidence)

Do **not** adopt Cloudscape wholesale. It would restyle every existing component, its own charts
would compete with Recharts, and its visual language is the AWS console's, which this product is
not. Do adopt its **patterns** (service dashboard, dashboard items, help system, empty states) and
its **icon set**, implemented on top of the existing CSS via design tokens
(`--font-size-*`, `--space-*`, `--color-*`, `--radius`) in `styles.css`. Revisit if the team grows
or a second product needs the same shell.

## 4. Suggested sequencing for a two-person team

1. Tier A in one PR (formatting, icons, top bar, typography, empty states) — visible change in a day.
2. B1 + B2 together (tile + help panel) — this is where "more guidance" actually lands.
3. B3 + B6 (global range + chart theme) — this is where cross-page consistency lands.
4. B4 + B5 (settings route, ROI table) — page-length fixes.
5. C1 + C2 (Overview + nav) — the structural change, last because it depends on B1/B2/B3.
6. C3 as a closing gate.

Each step is a separate intent chain under `intent/` and a separate PR, per the sdlc gate.
