# Intent: one time range for the whole portal

- **Slug:** global-time-range
- **Author:** Claude (AI agent)
- **Date:** 2026-09-18
- **Accepted-by:** Tim WU
- **Status:** shipped

## Problem

The 2026-09-18 audit (`docs/research-dashboard-ux.md`, defect 6) found that every page answered a
different question about time without saying so: Usage showed the last 7 days, Cost and Projects
all-time, Governance the current month, DORA a 7/30/90 toggle of its own, ROI a 30/90 toggle of its own.
Totals therefore disagreed across pages, and each page spent a paragraph explaining why. A reader
comparing two pages had no way to make them refer to the same period.

Two smaller defects ride with it: the Usage chart is hard-wired to seven hourly days, so no longer
view exists at all; and the DORA and ROI charts still carry hard-coded light-theme chrome and the
human/AI bar pair that failed the colour-vision check in feature-20's research.

## Evidence

Research finding R2 (3-0): period-over-period comparison is on by default in mature cost tools and
**the comparison range is labelled** (Vantage's own FAQ warns that an unlabelled default misleads).
Finding R3 (3-0): consistency across pages is a first-order component of "professional". The
dataviz method's interaction rule: **one filter row above everything it scopes; per-chart filters
are an anti-pattern.**

## Desired outcome

- One control in the top bar — 7 / 30 / 90 days / month-to-date — carried in the URL (`?window=`,
  the key DORA already used) so a link reproduces the view.
- Every page states the range it is actually showing. Pages that cannot honour a window coerce to
  the nearest one they can **and say so** ("month to date not available here"); pages with a fixed
  period (Cost and Projects = all-time rollups, Governance = AWS Budgets' month) show that as a
  caption where the control would be.
- Usage, DORA, ROI and Anomalies follow the range; Usage buckets to days past two weeks; Anomalies
  filters its feed and its empty state offers a way out (widen the window, or go to the guardrails).
- DORA and ROI charts adopt the validated theme: human/AI cohorts in blue/orange, the ROI waterfall
  in the diverging pair, hairline solid grids.

## Non-goals

- No API change: `/v1/anomalies` still returns the newest 100 detections and the page filters
  client-side; `/v1/costs` stays all-time (the windowed Cost table is feature-23's, on the Overview
  endpoint feature-22 adds).
- No change to any computed value.
- The DORA "Definitions & limitations" disclosure stays: it carries API-fed reference tables that the
  help registry does not duplicate.
