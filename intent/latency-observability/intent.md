# Intent: measure the latency we can actually measure, and name the rest of the chain

- **Slug:** latency-observability
- **Author:** Claude (AI agent)
- **Date:** 2026-09-18
- **Accepted-by:** Tim WU
- **Status:** accepted

## Problem

This product measures what AI coding **costs** (per project, via enforceable inference-profile
attribution), what it **delivers** (DORA per repo, AI-assisted and human-only cohorts) and what
that is **worth** (the ROI page). It measures nothing about how long any of it takes.

That gap is the live question in front of enterprise evaluators. An organisation running IDE and
CLI agents through an LLM gateway into Bedrock, with Guardrails in the path, asks how slow the
round trip is and where the time goes — and today this portal has no answer, so the answer comes
from somewhere else.

The tempting way to close that gap is the dishonest one: draw the whole request chain and put a
plausible number on every hop. This chain exists to close it the other way round.

## What we can and cannot see, established by inspection

`docs/research-latency-measurement.md` (deep research, adversarially verified; the angles that
failed are recorded as failed) plus direct inspection of this account:

- **CloudWatch `AWS/Bedrock` already publishes what we need for the Bedrock hop, with no code on
  our side.** `InvocationLatency` covers every invocation; `TimeToFirstToken` covers streaming
  invocations only. Both carry a `ModelId` dimension and support native percentile statistics, so
  p50/p95/p99 come from CloudWatch's own computation rather than ours.
- **These metrics carry no project, user or tenant dimension.** So this is a fleet view. It cannot
  be joined to the cost or DORA attribution, and the page must say so rather than letting a reader
  assume the numbers are theirs.
- **Three of the five hops are outside our telemetry entirely.** The developer's IDE/CLI hop needs
  the customer's Claude Code OpenTelemetry export; the gateway hop needs their LiteLLM Prometheus
  histograms; the Guardrails hop needs Converse called with tracing on. AWS does not document
  whether `InvocationLatency` includes guardrail evaluation, so we cannot even subtract it out.
- **Our own invocation logs do carry per-request latency** on streaming records, at
  `output.outputBodyJson[last]["amazon-bedrock-invocationMetrics"]`. That is the route to
  per-project latency — and it is deliberately **not** in this chain (see non-goals).
- **Three research angles produced no surviving evidence:** nothing links LLM response latency to
  developer productivity or adoption for coding assistants, no published enterprise evaluation
  framework covers latency alongside cost and feature parity in a citable way, and the
  cost-versus-latency trade-off figures did not survive verification. So the page must stay
  diagnostic. It may not imply that lower latency buys throughput.

## Desired outcome

- A `/latency` page that shows the measured Bedrock hop **to scale**, at a chosen percentile, over
  a chosen window, split into time-to-first-byte and the generation tail.
- The unmeasured hops drawn as part of the same chain, visibly hollow, each carrying the specific
  telemetry that would light it up — so the gap reads as a roadmap rather than an omission.
- Not one invented number. A hop we cannot measure carries no width, no duration and no estimate.
- The derived generation segment declared derived, because percentiles do not add.
- Streaming coverage stated as a figure, since the first-byte metric exists for streaming calls
  only and its lower sample count would otherwise look like a defect.
- No target, no benchmark, no "good" threshold: we hold no distribution to compare against.
- No claim that latency and developer productivity are related.

## Non-goals

- **Per-project latency.** It is real and reachable from the logs we already ingest, but it is a
  rollup change: three aggregate interfaces, three fold loops and four `ADD` writers need count,
  sum and bucket fields (not `+=`, because only streaming records carry the value), plus a guarded
  backfill for history — the `ADD` writers double-count otherwise. A separate chain.
- **Athena parity.** The Glue table for the invocation logs is created out of band and its `output`
  column does not include `outputBodyJson`, so the field is invisible to SQL. Changing that is a
  DDL decision about a table this repository does not own.
- **Any latency tile on the Overview page.** A number on the landing page implies a target we have
  no basis for.
- **Alarming or thresholds.** Same reason.
