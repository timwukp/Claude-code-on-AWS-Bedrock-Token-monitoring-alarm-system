# Intent: the dashboard tells the truth about what prompt caching costs — and cannot stop telling it

- **Slug:** cache-cost-truth
- **Author:** Claude (AI agent)
- **Date:** 2026-10-06
- **Accepted-by:** Tim WU
- **Status:** accepted

## Problem

From 2026-06-04 to 2026-10 the rate card priced input, output and cache-read tokens and never priced cache-write
tokens, which Bedrock bills at 1.25× the input rate (2× for a 1-hour cache). 1.24 billion such tokens — about $10.3 k
against a shown total of $14.4 k — were priced at $0 on every page; spend was understated by roughly 70 %. Feature-36
(`cache-write-pricing`, the ingestion owner's chain) fixes the pricing, the rollups and the history. Three things remain
that it does not cover:

1. **Copy that is now false.** "Billing discounts them" (Usage), "the cheapest tokens you can buy" (help), "Saved by prompt
   caching" (a gross figure that ignores the write premium), README and GOVERNANCE_FAQ's "~89 % lower than full input
   pricing", ROADMAP/VERIFICATION/ARCHITECTURE claims of "prompt-cache pricing" that meant reads only.
2. **No record of why it happened.** Four months of wrong numbers deserve a root-cause document, not a CHANGELOG line.
3. **Nothing that stops the next omission.** No test compared the token kinds the parser extracts with the kinds the card
   prices; no check compared the card with the published list; the one external anchor (AWS Budgets / Cost Explorer) reads
   $0 in this account and nobody reconciled from the payer account where the bill lives.

## Evidence

`docs/incidents/2026-10-cache-write-omission.md` (this chain) — timeline, root cause, the Price List rates confirmed
2026-10-06 (every existing card rate matches to the cent; every cache-write rate absent), and the lesson that
cross-page reconciliation proves consistency, not completeness.

## Desired outcome

- Every sentence on screen and in the docs that describes caching describes both halves: reads at 0.1×, writes at
  1.25× / 2×; the Cost tile becomes **"Net effect of prompt caching"** reading feature-36's `cacheNetUsd`; the estimate
  is labelled a lower bound (~9 %) until the standard-route correction lands.
- `pricing-completeness.test.ts` fails whenever the parser extracts a token kind the card does not price;
  `rollup-fields.test.ts` fails whenever a rollup writer or maintenance script omits a counter its aggregate carries or
  a rollup shape carries fewer counters than the hourly one.
- `scripts/check-rate-card.ts` diffs the card against the AWS Price List and exits non-zero on drift.
- `docs/RECONCILIATION.md` says how and where (payer account) the estimate is compared with the bill each month.
- Overview's and Projects' freshness copy says "latest logged call … · new logs rolled up every 15 minutes" and shows
  the aggregator's last run (`rollupsLastRunAt`, from feature-36) — closing qa F-PR68-001's misreading.

## Non-goals

- No pricing change: rates, rollups and backfill are feature-36's. This chain adds no rate and moves no token.
- No change to the qa agent's rules (a request is filed with its owner instead).
- Not wiring the drift script into CI until the owner grants the CI role `pricing:GetProducts`.
