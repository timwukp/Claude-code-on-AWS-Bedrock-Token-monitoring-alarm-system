# Research: why the dashboard priced prompt-cache writes at $0, and what the bill says they cost

- **Date:** 2026-10-05/06 · **Method:** deep-research harness (5 angles, 3-vote adversarial verification per claim)
  on the pricing question, then three direct inspections of live data that the harness could not do — the AWS Price
  List API, Cost Explorer by usage type, and raw invocation-log bodies in S3 — applied with the critical-thinking
  method: name the assumptions, test the most fragile one first, treat every number as a claim with a source.
- **Trigger:** the rate card (`backend/lambdas/api/cost-calc.ts`) priced input, output and cache-read tokens. It
  priced no cache writes, and the feature-34 report recorded that as a "known limit". The question was how large a
  limit, and what a correct card looks like.
- **Scope note:** every account id in this document is masked; tenant identities are described, not named. The
  product is generic — nothing here depends on who the customer is.

## Verdict

**Cache writes were the largest of the four token lines on the bill, and the dashboard showed them as $0.** Cost
Explorer, 2026-06-01 → 2026-10-05, SERVICE "Amazon Bedrock Service", by USAGE_TYPE:

| Line | Billed | Share of token spend | Priced by the card before feature-36 |
|---|---|---|---|
| Input | $4,285 | 12.8% | yes |
| Output | $5,163 | 15.4% | yes |
| Cache read | $11,666 | 34.8% | yes |
| **Cache write** | **$12,398** | **37.0%** | **no — $0** |
| Token lines | $33,512 | | |

Priced from its stored tokens with the corrected card, the largest tenant's all-time total moves from **$14,408 to
$25,540** (+77%): what the pages showed was **56%** of the product's own estimate of the invoice. A second, smaller
correction — the standard-route premium — remains open (see §5).

## 1. The billing oracle is Cost Explorer by usage type, and it reconciles to the cent

The harness's first round concluded "no primary Bedrock price source exists". That was wrong, and it was the most
consequential error to catch: there are two primary sources, both machine-readable.

- **AWS Price List API** (`AmazonBedrockFoundationModels`, us-east-1, "Global standard" route; Nova under
  `AmazonBedrock`). Per MTok, read 2026-10-05 and re-read independently by a second session 2026-10-06:

  | Model | Input | Output | Cache read | Cache write 5 m | Cache write 1 h |
  |---|---|---|---|---|---|
  | Fable 5.1 / Mythos 5.1 | 10 | 50 | 0.25 | 12.50 | 20.00 |
  | Fable 5 | 10 | 50 | 1.00 | 12.50 | 20.00 |
  | Opus 5.5 | 4 | 20 | 0.20 | 5.00 | 8.00 |
  | Opus 5 / Opus 4.8 | 5 | 25 | 0.50 | 6.25 | 10.00 |
  | Sonnet 5.5 | 2 | 10 | 0.10 (0.20 before the 2026-10-01 term) | 2.50 | 4.00 |
  | Sonnet 5 | 2 | 10 | 0.20 | 2.50 | 4.00 |
  | Sonnet 4.6 | 3 | 15 | 0.30 | 3.75 | 6.00 |
  | Haiku 4.5 | 1 | 5 | 0.10 | 1.25 | 2.00 |
  | Nova Micro | 0.035 | 0.14 | 0.00875 | 0 | 0 |

  Cache write is **1.25 × input (5-minute TTL) and 2 × input (1-hour TTL) on every Claude model**. 32 of the 33 input /
  output / cache-read rates already on the card matched the list to the cent; Sonnet 5.5's cache read moved from $0.20
  to $0.10 in the list term effective 2026-10-01 and was corrected here (the peer's drift check caught it).

- **Cost Explorer** names the kind and the route in the usage type:
  `USE1-anthropic.claude-<model>-mantle-cache-write-tokens-standard` (older models:
  `USE1-Claude4.6Sonnet-cache-write-input-token-count`); `-global-standard` for `global.` routes. It paginates — the
  first read stopped in mid-August and under-counted by a third until `NextPageToken` was followed.

**Reconciliation.** Athena over the raw logs, per model and route, priced with the new card at the 5-minute rate and
multiplied by the route factor (1.0 global, 1.1 standard), against the Cost Explorer cache-write lines — restricted to
days both sources fully cover (logging began **2026-06-03T06:54Z**; the bill begins 06-01):

| Model (route) | Estimate × route | Cost Explorer | Δ |
|---|---|---|---|
| Fable 5 (standard) | $7,098.56 | $7,099.64 | −0.02% |
| Opus 5 (standard) | $2,362.64 | $2,363.50 | −0.04% |
| Fable 5.1 (standard) | $1,427.45 | $1,427.55 | −0.01% |
| Sonnet 4.6 (standard) | $881.57 | $881.56 | 0.00% |
| Opus 4.8 (standard) | $375.22 | $375.22 | 0.00% |
| Opus 5.5 (standard) | $63.44 | $63.44 | 0.00% |
| Haiku 4.5 (standard) | $5.05 | $5.05 | 0.00% |
| **Total, 2026-06-04 → 10-05** | **$12,216.11** | **$12,216.63** | **−0.00%** |

Two lines do not reconcile and are explained rather than averaged away: Opus 4.6 ($0.52 billed, no logged tokens) and
the GPT model on Bedrock (1.5M logged cache-write tokens; Cost Explorer under the Bedrock service filter carries **no
line of any kind** for it — not input, not output — so the bill is silent, not negative. The Bedrock prompt-caching
guide prices GPT-5.6-and-later writes at 1.25× the uncached input rate with a single 30-minute TTL, and the card follows
the guide). The research's earlier "unexplained" residuals — Opus 4.8 +$126, Opus 4.7 $24.80 — were June 1–3
spend that predates the logs; the reconciliation window above removes them exactly.

## 2. Where the TTL can and cannot be read

The two TTLs differ by 60% in price, and the top-level `cacheWriteInputTokenCount` does not say which was used.
Three facts settle how to handle that:

1. **The logged response body carries the split.** On 4/4 sampled raw records,
   `usage.cache_creation.{ephemeral_5m_input_tokens, ephemeral_1h_input_tokens}` is present — under `message.usage` on
   the FIRST chunk (`message_start`) of a stream, on the object itself for `InvokeModel`. The 5-minute figure equalled
   the record's own `cacheWriteInputTokenCount`; the 1-hour figure was 0. (n = 4, one hour of traffic, two models via
   inference profiles — small, but the shape is the Anthropic Messages API's documented one.)
2. **Only the aggregator can read it.** The Glue table over the logs maps no response body, so Athena (the Full view)
   cannot. The aggregator already lifts latency from the body and deletes it (feature-28: the body is what ran a 4 GB
   heap out of memory at ~70k objects); the TTL split rides the same extract-then-discard pass.
3. **This account has only ever been billed the 5-minute kind.** Cost Explorer shows no 1-hour usage type, and the
   5-minute hypothesis reconciles to −0.00% above. Another account could differ — a 1-hour-heavy workload would be
   under-priced by up to 37.5% if 5 minutes were simply assumed — which is why the split is stored and the
   unknown-TTL count is exposed with a 1-hour upper bound, rather than assuming.

Decision (owner, 2026-10-05): read the TTL from the logs in the aggregator; price unknown-TTL writes at 5 minutes with
the 1-hour price as the bound; Athena assumes 5 minutes and the page says Fast alone sees TTLs; no Glue DDL change.

## 3. Why a priced card alone would not have fixed the pages

Only the USAGE rollup (per tenant-hour, models merged) ever stored `cacheWriteTokens`. MODEL, PROJECT and PROJDAY —
the items behind Costs, By project, Overview, ROI and DORA — stored nothing. Their writers use DynamoDB `ADD`, so a
re-run of the aggregator would double-count every other counter; history needs a guarded backfill in the style of
`backfill-latency.ts` (required cut-off at the deploy time of the new build, dry run by default, one conditional marker
per log object, stuck claims reported rather than re-added). Athena puts the all-time cache-write total at
1,253.1M tokens (2026-06-01 → 10-05); the dry run must reproduce it before anything is written.

## 4. A third defect found by reading the same code (qa F-PR68-002)

Three inference profiles priced every call at $0. They were not unresolved: the profile cache held their underlying
model (Amazon Nova Micro) and their names. They carried no `tums-project` tag, and the code treated "knows the
project" and "knows the model" as one fact — an untagged profile never entered the attribution map, so its calls kept
the opaque profile ARN as their model id, which no card row matches. Nova Micro was also missing from the card.
Fix: the model rewrite happens whenever the model is known; the project falls through to the lower tiers
(requestMetadata → identity hint → untagged) when the tag is absent; Nova Micro gets a row from the Price List.

## 5. What is still a lower bound, and by how much

The card holds one rate per model at the `global.` route price. Calls on `us.`/geo routes and through application
inference profiles are billed at the *standard* price, 1.1× — on this account that is 99.99% of cache-write spend, and
the missing premium leaves the total about 9% under the bill-equivalent figure. The owner decided (2026-10-05) that the route correction is a separate chain, so after
feature-36 the figures are a disclosed lower bound: roughly **$25.5k shown vs $28.0k bill-equivalent** for the largest
tenant. The Cost page states this beside the table.

## 6. Assumptions tested, and what each test did to them

| Assumption | Test | Result |
|---|---|---|
| "There is no primary Bedrock price source" (harness, round 1) | Price List API; Cost Explorer by usage type | Refuted — two primary sources, reconciling to −0.00% |
| Cache write = 1.25 × input | Price List per model; CE per model | Confirmed for the 5-minute TTL on every Claude model |
| The TTL is unknowable per call | Raw S3 log bodies | Refuted — present on 4/4 records, aggregator-readable only |
| The account uses 1-hour caching too | CE usage types; reconciliation at 5 m | Refuted for this account; kept observable for others |
| Unexplained residuals mean mis-pricing | First log timestamp vs CE daily | Refuted — Jun 1–3 spend predates logging |
| OpenAI-on-Bedrock cache writes cost 1.25× | CE lines for the model; then the prompt-caching guide | CE is silent (no lines at all for the model, so "no cache-write line" meant nothing); the guide confirms 1.25× for GPT-5.6+, one 30-minute TTL |
| "Unresolved" profiles cannot be priced | Profile cache contents | Refuted — resolved to Nova Micro, merely untagged |

## Sources

- AWS Price List API: `aws pricing get-products --service-code AmazonBedrockFoundationModels` (us-east-1, Global
  standard) and `--service-code AmazonBedrock` for `USE1-NovaMicro-*`.
- AWS Cost Explorer: `get-cost-and-usage`, `GroupBy USAGE_TYPE`, `SERVICE in {"Amazon Bedrock Service", "Amazon
  Bedrock"}`, 2026-06-01 → 10-06, all pages.
- Athena over `bedrock_invocation_logs`: per model × tenant token sums (28.96 GB scanned, ≈ $0.14) and first log
  timestamp.
- Raw S3 invocation-log objects, 2026-10-05 02h, four records (streaming and `InvokeModel`).
- Anthropic Messages API `usage.cache_creation` shape; Bedrock prompt-caching pricing page.
