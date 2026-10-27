# Intent: the Full view tells the truth about how fresh it is

- **Slug:** full-view-freshness-copy
- **Author:** Claude (AI agent)
- **Date:** 2026-10-27
- **Accepted-by:** Tim WU
- **Status:** shipped

## Problem

Lakehouse P0 (#76) moved the By project Full view from the raw Athena table to the ETL's curated Parquet, refreshed once
a day. Two things were left saying the opposite, and one was changed by accident:

1. The page's caption and the cost tile still said "Athena reads raw logs live … so it can run ahead of the 15-minute
   rollups" and explained the Athena-vs-rollups gap as "traffic since the last rollup". The direction is now reversed:
   Full lags the rollups by up to a day, and the gap is the two unresolvable attribution tiers plus traffic since the
   last ETL run. Help `project.source` said the same stale thing.
2. P0 gave every `/v1/queries` template a `dt` partition filter. The Full view runs the `byProject` template with
   `days=90`, so it silently became "last 90 days" while the header tiles and every sentence on the page are all-time.
3. The page has no way to say *which* day the curated data ends on.

## Desired outcome

- `byProject` is all-time again (its scan is ~1 MB on curated Parquet) and returns a trailing `data_through` column.
- The caption, the cost-tile footer, the "served from" chip and help `project.source` say: Full = curated Parquet written
  once a day (through <day>), lags the 15-minute rollups; the gap = tiers ③/④ + traffic since the last ETL run.
- Regression tests pin all-time `byProject`, the `data_through` column position, and the windowed templates' pruning.
