# Intent: price prompt-cache writes — the bill's largest token line was shown as $0

- **Slug:** cache-write-pricing
- **Author:** Claude (AI agent)
- **Date:** 2026-10-06
- **Accepted-by:** Tim WU
- **Status:** shipped

## Problem

A Bedrock bill has four token lines per model: input, output, cache read and cache write. The rate card
(`backend/lambdas/api/cost-calc.ts`) priced three. Cost Explorer for this account, 2026-06-01 → 2026-10-05, SERVICE
"Amazon Bedrock Service", grouped by USAGE_TYPE: input $4,285 · output $5,163 · cache read $11,666 · **cache write
$12,398 — 37.0% of token spend, the largest of the four, and $0 on every page**. The largest tenant's all-time total
reads $14,408; priced from the same stored tokens with cache writes it is $25,540 — the dashboard shows 56% of its
own estimate of the bill.

The omission had two parts. The card had no cache-write rate at all. And only the USAGE rollup (per tenant-hour,
models merged) ever stored `cacheWriteTokens`; MODEL, PROJECT and PROJDAY — the items behind Costs, By project,
Overview, ROI and DORA — stored nothing, so even a priced card would have had no tokens to price.

A third defect surfaced while reading the same code (qa F-PR68-002): three inference profiles priced at $0 because
model resolution was coupled to project tagging — an untagged profile's calls kept the opaque ARN as their model id.
All three resolve to Amazon Nova Micro, which the card also lacked.

## Evidence (full write-up: `docs/research-cache-write-pricing.md`)

- AWS Price List, `AmazonBedrockFoundationModels`, us-east-1, read 2026-10-05/06: cache write = 1.25 × input for the
  5-minute TTL and 2 × input for the 1-hour TTL on every Claude model (e.g. Fable 5.1 $12.50 / $20.00 per MTok).
  Nova Micro (`AmazonBedrock`, `USE1-NovaMicro-*`): $0.035 / $0.14 / cache read $0.00875 / cache write $0.
- Cost Explorer reconciles the card to the cent once both sources sit inside the logging window (logs begin
  2026-06-03T06:54Z): 2026-06-04 → 10-05, cache write **$12,216.11 estimated × route vs $12,216.63 billed (−0.00%)**,
  every model within 0.04%. The research's "unexplained" opus-4-8 (+$126) and opus-4-7 ($24.80) residuals are
  June 1–3 spend that predates the logs.
- The logged response body carries the TTL split (`usage.cache_creation.ephemeral_5m_input_tokens` /
  `ephemeral_1h_input_tokens`; on the first chunk of a stream, on the object for InvokeModel). 4/4 sampled records
  carried it; the 5-minute figure equalled `cacheWriteInputTokenCount`. The Glue table maps no response body, so only
  the aggregator can read it (the feature-28 extract-then-discard pattern); Athena cannot.
- GPT-5.6 cache writes: 1.25× uncached input per the Bedrock prompt-caching guide (one 30-minute TTL). Cost Explorer under
  the Bedrock service filter shows no line of any kind for this model, so it cannot confirm or refute; a first reading
  took that silence as "$0" and was corrected against the guide.

## Desired outcome

- Every page prices all four token kinds from one card. Cache writes are priced per logged TTL where known
  (Fast), at the 5-minute rate where not (history before the backfill, body-less records, Athena), with the 1-hour
  price exposed as an upper bound and the unknown count exposed beside it.
- MODEL, PROJECT and PROJDAY carry `cacheWriteTokens`, `cacheWrite5mTokens`, `cacheWrite1hTokens`, for new data by the
  aggregator and for history by a guarded, dry-run-first backfill.
- The runaway-spend guard prices cache writes, so a cache-heavy request can trip it.
- `SYSTEM#WATERMARK.lastRunAt` and `/v1/overview.rollupsLastRunAt` separate "the aggregator ran" from "the newest log
  folded in" (qa F-PR68-001 read a quiet weekend as a stale aggregator).
- Untagged inference profiles still resolve their model for pricing; the project falls through to the lower tiers.
  Nova Micro is on the card.

## Non-goals (owner decisions, 2026-10-05)

- **The standard-route premium (×1.1 on `us.`/geo/inference-profile calls) is a separate later chain.** Until it
  lands every figure is a disclosed lower bound, about 9% under the bill; the Cost page says so.
- Copy and docs that call caching a discount, `help-content.ts`, the RCA, README/GOVERNANCE_FAQ, the pricing-
  completeness and rollup-writer tests, the Price List drift script and the reconciliation runbook belong to the
  peer's next chain (`cache-cost-truth`), which reads the fields this chain creates.
- No Glue DDL change: Athena keeps assuming the 5-minute TTL and the page says Fast alone sees TTLs.
