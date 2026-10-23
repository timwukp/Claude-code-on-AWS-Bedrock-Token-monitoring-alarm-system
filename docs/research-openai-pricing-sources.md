# OpenAI models on Bedrock — where the prices come from, and what this account was billed

Read 2026-10-23 for feature-41 (chain A of the gateway study). Keep this file with the card: it is the provenance a
drift check needs for the rows the Price List does not carry.

## 1. The Price List API does not carry the frontier models
`aws pricing get-products` for `us-east-1`, every page, both service codes:

| Service code | OpenAI rows | What they are |
|---|---|---|
| `AmazonBedrock` | 66 | `USE1-gpt-oss-20b-*`, `-120b-*`, `-safeguard-*` (input/output, standard / batch / flex / priority) and their `openai.gpt-oss-*-mantle-*` twins. **No gpt-5.x / gpt-6 usage type.** |
| `AmazonBedrockFoundationModels` | 16 | `USE1-MP:USE1_<kind>_[long_ctx_][global_]standard-Units`, attribute `model: "OpenAI GPT-6 Astra"` — Marketplace rows for Astra only. |

So only gpt-oss (and Astra, under a shape the drift script does not read) can be checked against the Price List.

## 2. The AWS model cards publish every frontier model's price
`docs.aws.amazon.com/bedrock/latest/userguide/model-card-openai-<model>.html`, section "Pricing", USD per 1M tokens,
Standard tier, **short context (≤ 272K input tokens)**. Every card states that In-Region and Geo CRIS include a 10%
premium over the OpenAI rate and Global CRIS does not — i.e. the same two-tier structure as the Claude rows, so the
card's **Global CRIS** figure is what `RATE_CARD` stores and `routeMultiplier()` applies ×1.1 to `us.` / bare ids.

| Model (card id) | Launch | Input | Cache write (30 min) | Cache read | Output | Long context (> 272K) |
|---|---|---|---|---|---|---|
| gpt-5.6-luna | 2026-07-13 | $0.20 | $0.25 | $0.02 | $1.20 | ×2 in / cache, ×1.5 out |
| gpt-5.6-sol | 2026-07-13 | $4.00 | $5.00 | $0.40 | $20.00 | $8 / $10 / $0.80 / $30 |
| gpt-5.6-terra | 2026-07-13 | $2.00 | $2.50 | $0.20 | $12.00 | $4 / $5 / $0.40 / $18 |
| gpt-6-astra | 2026-09-08 | $10.00 | $12.50 | $1.00 | $50.00 | $20 / $25 / $2 / $75 (Ultrafast ×6) |
| gpt-6-luna | 2026-09-22 | $0.10 | $0.125 | $0.01 | $0.50 | $0.20 / $0.25 / $0.02 / $0.75 |
| gpt-6-sol | 2026-09-22 | $2.00 | $2.50 | $0.20 | $10.00 | $4 / $5 / $0.40 / $15 |

Regularities the card relies on: cache read = 0.1× input; one 30-minute cache-write TTL = 1.25× input (both TTL
columns of a row carry it); In-Region = Geo CRIS = 1.1 × Global CRIS. The Astra Marketplace rows in the Price List
agree with its card to the cent ($10 / $11, $50 / $55, $1 / $1.10, $12.50 / $13.75; long_ctx $20 / $22 …).

**Correction this implies:** the feature-36 row `gpt-5.6-sol` ($1.25 / $10, "GPT-5 family") was 3.2× under its card.
The 608 August calls on this account (46,625 in, 4,314,612 out, 1,477,708 cache-write tokens, `us.` route) are
≈ **$103.25** at the card, not $47.5.

Model ids the cards name (all lower-case in the logs): `openai.<model>` on bedrock-mantle; `us.openai.<model>`,
`global.openai.<model>` (and `in.openai.<model>` for India) on bedrock-runtime.

## 3. What Cost Explorer says this account paid for OpenAI: $0.00
`GetCostAndUsage` 2026-06-01 → 10-23, MONTHLY, grouped SERVICE × USAGE_TYPE, **no service filter, all 3 pages**:

- Bedrock totals for the period: "Amazon Bedrock Service" $41,741.74 · "Amazon Bedrock AgentCore" $315.75 ·
  "Amazon Bedrock" $219.75. No SERVICE named for OpenAI or a Marketplace listing of it (the one Marketplace line is
  an unrelated $0.28 "Claude Platform" item).
- Every OpenAI usage type is **$0.0000 with non-zero quantity**: `openai.gpt-5.6-luna-mantle-*`, `openai.gpt-6-luna-
  mantle-*` (incl. `cache-write-tokens-30m`), `openai.gpt-6-sol-mantle-*`, `gpt-oss-20b-*`; split across the SERVICEs
  "Amazon Bedrock" (APS1 / some USE1 lines) and "Amazon Bedrock Service" (USE1 lines) — the collector reads both.
- **gpt-5.6-sol has no usage type at all** in any month, under any service, despite 608 logged calls in August.

Conclusion: AWS has not charged this account for any OpenAI model to date. The card is still the published rate —
this is generic software, and an account that is charged must see the right number — so the bill panel carries the
truth per model (`billedZero`, `billedZeroEstimateUsd`) instead of the card pricing them at $0.
