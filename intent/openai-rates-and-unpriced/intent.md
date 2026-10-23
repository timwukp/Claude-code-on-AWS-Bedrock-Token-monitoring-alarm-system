# Intent: price OpenAI models at their published Bedrock rates, and never let a $0 estimate be silent

- **Slug:** openai-rates-and-unpriced
- **Author:** Claude (AI agent)
- **Date:** 2026-10-23
- **Accepted-by:** Tim WU
- **Status:** accepted

## Problem

Three defects share one root: the rate card had no primary source for OpenAI models and no way to say "I cannot price this".

1. **`matchRate` took the first substring hit.** `openai.gpt-5.6-luna` contains `gpt-5`, so the Cost page labelled a Mantle
   model `gpt-5` while the Latency page said `openai.gpt-5.6-luna` (qa F-PR73-N02), and every point release had to be
   hand-ordered above its family row.
2. **The `gpt-5.6-sol` row was a guess** — $1.25 / $10 per MTok "from the GPT-5 family" (feature-36) — and the generic
   `gpt-5` row priced every unknown GPT id at that guess. The AWS model cards (read 2026-10-23) publish gpt-5.6-sol at
   **$4 / $20 (Global CRIS)**: the 608 August calls on this account are ≈ $103, not $47.5 — 3.2× under.
3. **Unpriced models were invisible.** deepseek-r1, two kimi models, llama3-8b, ministral-3b, nova-pro and (until
   feature-41) gpt-6-luna sat in every total at $0 with nothing on any page saying so — exactly how OpenAI usage read as
   free before feature-36.

One more fact changes how the fix must read: **Cost Explorer has billed this account $0 for every OpenAI model, every
service, 2026-06-01 → 10-22** (3 pages of SERVICE × USAGE_TYPE walked; every OpenAI line is $0.00 with non-zero quantity;
gpt-5.6-sol has no line at all). A list-price estimate for OpenAI usage will therefore always exceed this account's bill.
The card must still carry the published rates — this is generic software and another account IS charged them — so the
place to tell the truth is the feature-40 bill panel, per model.

## Desired outcome
- `matchRate` picks the **longest matching key**; the Athena rate CASE tests keys longest-first so both paths agree.
- Card rows for gpt-5.6-luna / sol / terra and gpt-6-astra / luna / sol from their AWS model cards (Global CRIS tier,
  short context, cache read 0.1×, one 30-minute write TTL at 1.25×; In-Region / Geo CRIS = ×1.1 via `routeMultiplier`),
  gpt-oss-20b / 120b from the Price List; **no generic `gpt-5` row**.
- `unpricedModels: [{modelId, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, invocations}]` on `/v1/costs`,
  `/v1/overview`, `/v1/projects` (fast), rendered on all three pages.
- The bill panel marks a row **`billedZero`** when the logs price a model but the bill charged $0.00 for it, sums that
  list-price estimate (`billedZeroEstimateUsd`), and the logged share is Σ min(billed, logged) per model.
- Identity hints match the **role** behind an assumed-role session (`arn:aws:iam::<acct>:role/<r>` or the session-less
  `assumed-role/<r>` covers every `assumed-role/<r>/<session>`), so one hint attributes a CI runner or agent role.
- Governance / Overview say in one sentence why the AWS Budget figure is larger than the bill panel's.

## Non-goals
- Pricing Bedrock Mantle tokens (no cache split — feature-40 stands). Long-context (> 272K input) OpenAI rates — the
  rollups cannot tell a long-context call apart; stated as a floor. The peer's chain B (UI/docs/allowlist/cache churn)
  and the tenant-key rule for assumed-role ARNs (backlog) are separate.
