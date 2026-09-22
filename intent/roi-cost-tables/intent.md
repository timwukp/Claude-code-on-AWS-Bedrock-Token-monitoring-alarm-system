# Intent: one table and one chart where there were eighteen charts

- **Slug:** roi-cost-tables
- **Author:** Claude (AI agent)
- **Date:** 2026-09-19
- **Accepted-by:** Tim WU
- **Status:** shipped

## Problem

Two pages fail the same test — can a reader compare things without scrolling — for opposite reasons.

- **AI ROI** stacks one waterfall chart per project: 18 near-identical panels, 9 800 px tall, each
  saying "ROI not computable" with the same paragraph. The dataviz method's first rule is that a
  one-number story is a stat, not a chart; eighteen of them is a table.
- **Cost** lists 26 rows for what are 17 models — Bedrock meters one model under `us.`, `global.` and
  bare ids — in raw monospace identifiers, 15 of them `$0.00`, with the cache-savings column printed
  in green (text wearing a data colour), and no totals row against which the KPI above can be checked.

Both were defects 7–9 of the 2026-09-18 audit (`docs/research-dashboard-ux.md`). Two small ones rode in
from qa: the Anomalies empty state offered "Show last 90 days" when the window already was 90 days
(#51), and the new Overview Deployment-frequency tile summed **per-day** rates and printed them as
per week — a ≈7× under-report (F-PR53-102 on #53, diagnosed by the other session against `dora-calc.ts`).

## Evidence

Research finding R3 (3-0): limit the metrics per view, strip what does not aid interpretation, keep
layout and units consistent. Dataviz standards (chart §1, table §§2–8): one chart per story, tables
with the unit in the header, a totals row where the KPI is the sum, friendly label + secondary raw id,
default-hidden noise rows behind a labelled toggle, `aria-sort` on sortable headers.

## Desired outcome

- ROI: one sortable table (project · spend/mo · break-even h/mo · evidence · value/yr · investment/yr ·
  ROI or a short reason) and **one** detail panel — waterfall, refusals, unit economics, assumptions
  drawer — for the selected project. Selection is in the URL (`?project=`) and is shared with the model
  diagram and the estimator, so the page has one "current project".
- Cost: regional variants merged into one row with region chips, friendly names with raw ids as a
  secondary line, tokens in compact figures, units in headers, a totals row, rows under one cent folded
  behind a toggle, `aria-sort` headers, an "All time" footer line naming the shared rate card.
- Anomalies: at 90 days the empty state offers the guardrails page, not a dead widen button.

## Non-goals

- Cost stays on `/v1/costs` (all-time). Windowing the table on `/v1/overview.byModel` waits until that
  endpoint is deployed and verified on dev — adding a second undeployed dependency now would only feed
  qa another environment-caused HIGH.
- No computed value changes; no `format.ts` change.
