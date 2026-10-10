# Intent: price the standard route — the last known gap between the estimate and the bill

- **Slug:** standard-route
- **Author:** Claude (AI agent)
- **Date:** 2026-10-10
- **Accepted-by:** Tim WU
- **Status:** accepted

## Problem

The rate card holds one rate per model at the AWS Price List's **"Global standard"** tier — the price of a `global.`
cross-region call. Every other route is billed at the **"standard"** tier, ×1.1: `us.`/`eu.`/`apac.` geo cross-region
profiles, direct single-region calls, and application inference profiles (which the aggregator stores as their bare
underlying model id). On this account that is 99.99% of spend, so since feature-36 the pages have carried a disclosed
caveat: "a lower bound, roughly 9% under the bill". The largest tenant reads $25,540.84 for 2026-06-01 → 10-05 against a
bill-equivalent $28,094.61 (+10.00%; every one of its calls is on a `us.` route).

## Evidence

- AWS Price List (`AmazonBedrockFoundationModels`, us-east-1): every Claude model lists both tiers (e.g. Sonnet 5.5
  `input_tokens_global_standard` $2.00 vs `input_tokens_standard` $2.20 per MTok); **so do OpenAI models on Bedrock**
  (GPT-6 Astra $10.00 vs $11.00, re-read 2026-10-10); Amazon Nova lists a single tier.
- Cost Explorer names the tier in the usage type (`…-standard` vs `…-global-standard`), and the feature-36
  reconciliation already proved the factor on the largest line: cache write, estimate × route vs bill, 2026-06-04 →
  10-05, $12,216.11 vs $12,216.63.
- Applied to all four token kinds for this chain (same window, every model × route × kind): **estimate $33,040.54 vs
  Cost Explorer $33,033.63 (+0.02%)**; input −0.14%, output +0.59%, cache read −0.14%, cache write −0.00%.

## Desired outcome

- `computeModelCost` applies a route factor to every dollar figure: 1 for `global.` ids and single-tier models, 1.1
  otherwise; the factor is exposed per row (`routeMultiplier`). The card's stored rates stay at the global tier, so the
  peer's Price List drift check keeps matching.
- The Athena (Full) view applies the same rule in SQL, so Fast and Full agree.
- Every "lower bound / premium not yet applied" sentence comes out of the pages, the help text and
  `docs/RECONCILIATION.md`; the incident record's bullet is marked resolved rather than deleted.

## Non-goals

- GPT "long context" tiers (2× on the list) are not priced — stated as a known limit.
- No data moves: the route is read from the stored model id at read time; no backfill.
