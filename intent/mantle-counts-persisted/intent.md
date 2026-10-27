# Intent: Mantle counts that do not vanish two weeks after the traffic stops

- **Slug:** mantle-counts-persisted
- **Author:** Claude (AI agent)
- **Date:** 2026-10-27
- **Accepted-by:** Tim WU
- **Status:** shipped

## Problem
qa on PR #77 (live dev, 2026-10-27): the Cost page's bill panel showed opus-5-5 with **$1,115.68 "not logged"** — 99.9% of
the window's unlogged total — and **"—" for Mantle inferences and tokens**, while the panel's own text attributes unlogged
spend to Bedrock Mantle. On 2026-10-23 the same row read 5,816 inferences.

Root cause (read-only check): CloudWatch **`ListMetrics` lists only metrics with datapoints in the past ~2 weeks**.
Feature-40's `readMantle` used it to discover the `AWS/BedrockMantle` `Model` values and then queried each by name. Opus
5.5's last Mantle datapoint was 2026-10-11; by 10-25 it was gone from the list, so it was never queried — while
`GetMetricData` with the explicit dimension still returned 5,816. The per-model-vs-fleet check fired
(`mantleInconsistent: true`) — correctly — but only as a footnote under a table whose row said "—".

Second, smaller: the OpenAI 30-minute cache-write usage type (`…-mantle-cache-write-tokens-30m-…`) was not recognised by
`bill-parse`, so it fell through as a bogus "model" with kind `other`.

Third (qa F-PR77-006, same page): while `/v1/costs` is still loading, the Spend-by-model footer read "All-time total
unavailable — the costs endpoint did not respond" — the pending state rendered as an error.

## Desired outcome
- The daily bill collector stores Mantle counts **per model per UTC day** (`MANTLE#DAILY`) and the fleet series per day
  (`MANTLE#FLEET`), asking CloudWatch **by name** for every model it lists now ∪ every model stored before ∪ every model
  the bill names in the window. The pages read the table; only days after the last stored day are read live.
- `mantleInconsistent` is shown **on the row** ("unresolved") where unlogged dollars have no count, not only in the note;
  the note states the stored-through day.
- `cache-write-tokens-30m` parses as kind `cacheWrite30m` and folds into the panel's cache-write column.
- The Cost page footer distinguishes loading from failure.

## Non-goals
Pricing Mantle tokens (no cache split — unchanged). Metric Streams → bronze (peer's P1) will supersede the live read
later; this chain makes the current panel truthful now.
