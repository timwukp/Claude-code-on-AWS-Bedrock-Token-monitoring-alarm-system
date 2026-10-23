# Intent: show the spend the invocation logs never see (Bedrock Mantle)

- **Slug:** mantle-visibility
- **Author:** Claude (AI agent)
- **Date:** 2026-10-15
- **Accepted-by:** Tim WU
- **Status:** shipped

## Problem

Since 2026-10-06 a growing share of this account's Bedrock traffic goes through **Bedrock Mantle**. It is billed under
the ordinary Cost Explorer usage types but **never reaches the model-invocation logs**, so every rollup, page and
reconciliation misses it. Three sources agree exactly for Opus 5.5, 2026-10-06 → 10-13:

| | input | output | cache read | cache write |
|---|---|---|---|---|
| invocation logs | 2.3M | 4.58M | 1,032M | 56.7M |
| Cost Explorer | 9.9M | 12.7M | 2,500M | 156M |
| difference | 7.6M | **8,112,548** | 1,468M | 99.6M |
| `AWS/BedrockMantle` (Model = opus-5-5) | TotalInputTokens **1,574,987,404** = the input-side difference within 6 tokens | TotalOutputTokens **8,112,548** | | Inferences 5,816 |

$1,098 of the $1,748 billed for Opus 5.5 in that window — 63% — was invisible to the dashboard. The "+0.02%"
reconciliation of feature-38 held through 10-05 and is already stale for this model. Also learned: the `-mantle-`
infix is on every Claude usage type and is not a Mantle-endpoint marker; Mantle's CloudWatch token metric has no cache
split (InputTokens == TotalInputTokens, ~93% cache reads on the bill), so tokens × rate would overstate ~6×; Cost
Explorer's API costs $0.01 per request.

## Desired outcome
- A daily collector copies the bill's Bedrock lines into the aggregates table; no page view calls Cost Explorer.
- `/v1/costs` and `/v1/overview` carry a `bill` block: per model, billed vs the logged estimate on the same days, the
  difference named "not logged", with Mantle inferences/tokens as the explanation — never priced.
- `/v1/latency` reports Mantle inferences and client errors with "latency not published by AWS".
- The Cost page shows the comparison; the Overview spend tile states the unlogged amount beside the logged figure.
  Headline numbers stay "logged, reconcilable" and are not merged with the bill.

## Non-goals
Pricing Mantle tokens; per-project attribution of Mantle calls (impossible — no logs); a Mantle hop in the latency
chain (Mantle is a parallel endpoint, not a stage of the logged path); frontend copy polish (the peer's chain B).
