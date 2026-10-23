# Research: the spend the invocation logs never see — Bedrock Mantle

- **Date:** 2026-10-14 · **Method:** three independent sources for one model and window, compared token by token:
  the model-invocation logs (Athena), Cost Explorer (by usage type) and CloudWatch `AWS/BedrockMantle`.
- **Trigger:** a peer session's gateway study reported Mantle usage in CloudWatch and `openai.gpt-6-*-mantle-*` usage
  types in Cost Explorer. The first reading of those names was wrong (see §3), so the question was asked directly:
  does the bill contain spend the logs do not?
- Account ids are masked; the product is generic.

## 1. Finding

For **Opus 5.5, 2026-10-06 → 10-13**:

| Source | input | output | cache read | cache write | calls |
|---|---|---|---|---|---|
| Invocation logs (Athena, `modelId LIKE '%opus-5-5%'`) | 2,306,247 | 4,579,401 | 1,032,151,938 | 56,725,887 | 4,086 |
| Cost Explorer (all `opus-5-5` usage types, both routes, 5 m + 1 h) | 9,914,923 | 12,691,949 | 2,499,949,194 | 156,307,353 | — |
| **Cost Explorer − logs** | 7,608,676 | **8,112,548** | 1,467,797,256 | 99,581,466 | — |
| `AWS/BedrockMantle`, `Model = anthropic.claude-opus-5-5` | TotalInputTokens **1,574,987,404** | TotalOutputTokens **8,112,548** | | | Inferences **5,816** |

The input-side difference (input + cache read + cache write = 1,574,987,398) equals Mantle's `TotalInputTokens` to
within **6 tokens**; the output difference equals `TotalOutputTokens` **exactly**. So:

1. **Mantle traffic is billed, in full, under the ordinary usage types** — the same lines the feature-36/38
   reconciliations matched to the cent for logged traffic.
2. **It never reaches the model-invocation logs**, so no rollup, page or per-project attribution sees it.
3. In dollars for that window: Cost Explorer $1,748.12 for Opus 5.5; the logged tokens price to $649.96; **$1,098.16
   (63%) was invisible to the dashboard**. Mantle inferences (5,816) outnumbered logged calls (4,086).
4. Mantle traffic began **2026-10-06** (daily inferences 10 → 122 → 2,830 → 2,146 → 694 → 16 → 411). The feature-38
   reconciliation (+0.02%, 2026-06-04 → 10-05) is correct for its window and already stale for this model.

## 2. What CloudWatch can and cannot tell about Mantle

`AWS/BedrockMantle` carries `Inferences`, `InferenceClientErrors`, `InputTokens`, `OutputTokens`, `TotalInputTokens`,
`TotalOutputTokens`, dimensioned by `Model` and by `Project` (Mantle's own project concept; only `default` so far), plus an
undimensioned fleet series. **`InputTokens` equals `TotalInputTokens`; there is no cache split.** On the bill ~93% of
those input-side tokens were cache reads, so pricing Mantle tokens at the input rate would read ≈ $6,900 against ≈
$1,100 actually billed. Therefore the product **never multiplies Mantle tokens by a rate**: dollars for unlogged traffic
come from Cost Explorer; CloudWatch supplies the counts that explain them.

Summing the `Model` series must not be mixed with the fleet series (the same aggregate-vs-dimension trap as
`AWS/Bedrock`); the product sums the `Model` series and flags a > 1% disagreement with the fleet.

## 3. Corrections to earlier claims
- "`-mantle-` in a usage type marks the Mantle endpoint" — **wrong**. Every Claude usage type carries it
  (`USE1-anthropic.claude-fable-5-1-mantle-cache-write-tokens-standard`); it is the newer billing naming, and Mantle
  calls share these lines with logged calls.
- "GPT-6 / GPT-5.6 on Mantle is an unpriced gap in dollars" — not today: their lines exist with tiny quantities and
  **$0.00** billed (10-14). The rate rows still belong on the card (chain A), for correctness, not dollars.
- "This account has 0 one-hour cache-write usage types" (feature-36) — true through 10-05; since 10-06 `opus-5-5` bills
  `cache-write-tokens-1h-standard` and `-1h-global-standard` ($80.60 in 10-06 → 10-13).
- "No known pricing gap remains" (feature-38) — true for **logged** traffic only.

## 4. Design consequence (feature-40)
A daily collector copies Cost Explorer's Bedrock lines into the aggregates table (the API costs $0.01 per request, so no
page view calls it). The API compares, per model and per billed day, the bill with what the logs price, names the
difference "not logged", and attaches Mantle's counts. The headline figures stay "logged, reconcilable" and are not
merged with the bill; the comparison sits beside them.

## Sources
- Athena over `bedrock_invocation_logs` (per-model sums, 2026-10-06 ≤ timestamp < 10-14).
- `aws ce get-cost-and-usage` DAILY/MONTHLY by `USAGE_TYPE`, SERVICE ∈ {"Amazon Bedrock Service","Amazon Bedrock"}.
- `aws cloudwatch get-metric-statistics` / `list-metrics`, namespace `AWS/BedrockMantle`.
