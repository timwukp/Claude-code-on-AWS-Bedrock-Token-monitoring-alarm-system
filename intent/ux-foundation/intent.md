# Intent: make the portal read as one professional instrument — tokens, icons, tiles, help, dark theme

- **Slug:** ux-foundation
- **Author:** Claude (AI agent)
- **Date:** 2026-09-18
- **Accepted-by:** Tim WU
- **Status:** shipped

## Problem

The owner's verdict on the deployed portal: it "looks not professional", lacks guidance, and users
struggle to understand what they are seeing. A deep-research run (108 agents, 25 sources, 23 claims
confirmed by three-vote adversarial review, 2 refuted) and an authenticated Playwright audit of all
seven routes — both recorded in `docs/research-dashboard-ux.md` — turned that verdict into twelve
concrete defects. The ones this chain owns:

1. **Emoji as iconography.** Nav (📊 💰 🗂️ 🛡️ 🔔 🚀 📈), user chip (👤), empty states (✅ 📦 📭 🗂️)
   and brand (◆) render differently per OS, cannot follow active/disabled state, and carry no
   accessible name.
2. **A flat, unlabelled navigation.** Seven items under one "Monitoring" heading; no grouping by
   what the reader is trying to do (spend, governance, delivery).
3. **A stray control.** `LoginGate.tsx` renders a browser-default `Sign out` outside the shell — Arial
   on `#efefef` in the top-right — duplicating the one in the sidebar footer.
4. **KPI cards are label + value + caveat.** No delta versus a prior period, no trend, no status,
   no way to ask "what is this?" other than reading a two-line caption. The card the whole product
   is built on cannot yet carry the anatomy the research calls for.
5. **Definitions live in hover tooltips or in a collapsed drawer at the foot of a 6 400 px page.**
   Thirty-six `title=` attributes across the app; five `aria-label`s in total.
6. **Empty states without a path.** Anomalies shows three zeros and an emoji; nothing says what
   would populate the panel or where to go.
7. **Typography drift.** Nine font sizes (11–28 px), five weights including a non-standard 650,
   three families (Inter, SF Mono, and Arial leaking from unstyled native controls).
8. **Chart chrome is copy-pasted and light-only.** Grid, tick, axis and tooltip hex values are
   repeated in four places; the Usage chart uses saturated gradient fills and dashed gridlines; the
   DORA human/AI bar pair (`#2563eb` vs `#6366f1`) **fails** the colour-vision check — normal-vision
   ΔE 6.6 against a floor of 15, protan ΔE 1.9 — so the two cohorts are not distinguishable.
9. **The light content plane reads as generic.** The owner wants the whole surface unified with the
   dark sidebar.

## What the evidence supports — and what it does not

Verified 3-0 (sources in the research doc): visual professionalism is hierarchy, restraint and
cross-page consistency (Carbon, NN/g); KPI tiles carry label, definition, value, delta with a
labelled comparison range, status and an info link (AWS Billing, Vantage, Cloudscape); definitions
belong in a progressively-disclosed help panel, never hover-only (NN/g, Cloudscape, WCAG 2.2
SC 1.4.13); every empty state states status and offers an action (NN/g, Cloudscape).

**Refuted:** both claims that Cloudscape's iconography guidance forbids emoji or decorative icons.
No surviving source says emoji are unacceptable in enterprise UI. Replacing them here is a
consistency-and-brand judgement resting on Carbon's restraint principle — this chain and its report
must say so, not cite it as a rule.

**No evidence either way:** dark versus light for finance dashboards. Observability tools default
dark; cost tools default light; this product is both. Dark is therefore the owner's preference
applied to a question the research left open, not a research finding.

**Measured, not argued:** the colour palettes in this chain were run through a colour-vision
validator against the actual surfaces (`#111a2e` dark, `#ffffff` light). The eight-slot categorical
set passes every gate on dark; on light three slots sit below 3:1 and therefore always ship with a
direct label or the table view.

## Desired outcome

- One set of design tokens (type scale, spacing, semantic colour, chart chrome, series slots)
  that every component and every Recharts usage reads from; two value sets — dark by default,
  light as an explicit opt-in (`data-theme="light"`), not OS-driven.
- A hand-rolled SVG icon set with accessible names; navigation grouped **Spend / Governance /
  Delivery**; a wordmark; one Sign out.
- A `KpiTile` with the full anatomy — definition, delta versus a named period, optional sparkline
  and status, an info button — behind the existing `Kpi` signature so every page upgrades at once
  without touching it.
- A help panel (right rail on wide screens, modal below) keyed by a single content registry, opened
  from info buttons; keyboard-openable, Esc-closable, focus-restoring.
- An `EmptyState` with status text and an action slot.
- A chart theme module carrying the validated series colours (assigned per entity, never by rank),
  hairline solid grid, flat 10 % area fills, thin marks and a tooltip on the surface token —
  applied to the Usage chart in this chain and to the remaining charts as their pages are touched.
- `StatCard.tsx`, imported by nothing, removed.

## Non-goals

- No page restructuring, no new routes (Overview, Settings), no global time-range picker, no
  change to any number or API — those are the four chains that follow.
- No adoption of Cloudscape or any component library; its patterns and icon shapes, on our CSS.
- No claim that emoji, light themes or long captions are "wrong" — only that consistency, an
  accessible disclosure layer and a validated palette are better.
