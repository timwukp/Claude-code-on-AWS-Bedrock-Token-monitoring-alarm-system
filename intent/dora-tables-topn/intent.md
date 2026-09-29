# Intent: DORA tables open on their top rows

- **Slug:** dora-tables-topn
- **Author:** Claude (AI agent)
- **Date:** 2026-09-29
- **Accepted-by:** Tim WU
- **Status:** accepted

## Problem

The DORA page ends in three tables that grow with the data: the selected repository's recent merged PRs (up to
25), all tracked repositories (currently 8, growing with each repo added) and projects × cost (20 registered
projects). All three render every row, in the API's order, so the page is ~5,700 px tall and the rows a reader
came for — the busiest repositories, the most expensive projects — sit wherever the registry put them. Table
standard 4 in `docs/research-dashboard-ux.md` ("default top 10 + Show all N") and standard 5 ("default sort by
the value column") were adopted for the Cost and ROI tables in features 24/27 but never reached DORA.

## Evidence

Research finding R3 (3-0): limit what a view carries; defer what does not aid interpretation. The three tables
already hold their rows in component state; ranking and cutting is a presentation change with no API impact.

## Desired outcome

- Each of the three tables shows its top 10 rows by default with a "Show all N" control (and "Show top 10 of N"
  to fold back); tables with 10 rows or fewer are unchanged.
- Ranking: recent PRs newest first (already the API's order); repositories by merged PRs, descending; projects by
  estimated spend, descending. The panel caption names the ordering and, when cut, how many rows are shown.
- No number changes; no API change.

## Non-goals

- No column sorting controls on these tables (the ROI and Cost tables have them; DORA's columns are read as a
  set, not ranked individually).
- No change to the KPI cards, charts or the cohort panel above the tables.
