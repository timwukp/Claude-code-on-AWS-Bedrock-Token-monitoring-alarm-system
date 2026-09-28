# Intent: latency per project, from the calls we already log

- **Slug:** latency-per-project
- **Author:** Claude (AI agent)
- **Date:** 2026-09-23
- **Accepted-by:** Tim WU
- **Status:** accepted

## Problem

`/latency` (feature-18, #52/#53) shows model-hop latency for the whole account: CloudWatch
`AWS/Bedrock` publishes `InvocationLatency` and `TimeToFirstToken` with exact percentiles, but with
**no project, user or tenant dimension**. ROADMAP row 13 is 🟡 for exactly that reason: the page
cannot answer "is *my* project slow?", which is the question a team lead asks. The page says so.

The number needed is already being logged and thrown away. Every Bedrock invocation log record with
body logging on carries `output.outputBodyJson[last]["amazon-bedrock-invocationMetrics"]` =
`{ invocationLatency, firstByteLatency, … }` (verified on a real record 2026-09-23: 8019 ms / 4180 ms).
The aggregator reads those records for token counts and discards the body — it has never read the
metrics. Because the aggregator also already attributes every call to a project through four tiers
(AIP tag ▷ requestMetadata ▷ identity hint ▷ untagged), folding latency into the same rollups makes it
per-project for free.

## Why not before

The body is the payload that ran a 4 GB heap out of memory at ~70k records in `backfill-projday.ts`
(`:100-102`). Any design that keeps bodies around dies at scale. The rule is therefore
**extract-then-discard**: `parseLogFile` lifts the one key it needs and deletes the body before the
record leaves the parser.

Percentiles do not add. A per-project p95 cannot be produced by summing anything simple — but
count + sum + **fixed-edge buckets** are all additive, so batches can be `ADD`ed onto DynamoDB items
the way every other rollup counter is, and a percentile can be read off the merged histogram. The
price is that the figure is an estimate to within a bucket's span, and the page must say so, with
the exact fleet figures beside it as the reference.

## Non-goals

- Athena/Full-view parity (phase 1c). The Glue table's `output` struct has no `outputBodyJson`; the
  body is an array for streaming calls and an object otherwise, so a typed column would break on
  half the rows, and the table is created out-of-band, not by CDK. That is a separate decision.
- Any claim linking latency to developer productivity. The feature-18 research found no evidence.
- Client, gateway or Guardrails hops. Still dark; still labelled dark.
