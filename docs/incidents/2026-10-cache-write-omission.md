# Incident: prompt-cache write tokens were never priced (2026-06-04 → 2026-10)

- **Severity:** high — the dashboard's primary number (estimated Bedrock spend) was understated by roughly 70 % on
  every page, for the whole history of the product.
- **Detected:** 2026-10-05, by the ingestion owner's token-kind inventory while scoping rate-card work. Not by a test,
  not by the UI qa agent, not by a user.
- **Fixed by:** feature-36 `cache-write-pricing` (pricing, rollups, backfill) and feature-37 `cache-cost-truth` (copy,
  docs, guards — this document).
- **Data loss:** none. Cache-write counts were extracted and stored in the hourly rollups from day one; only the
  pricing and the per-model / per-project rollups were missing, so history was repriced from existing data.

## What was wrong

Bedrock reports four token kinds per call: input, output, **cache read** and **cache write**. Anthropic bills a cache
read at 0.1× the input rate and a cache **write at 1.25× (5-minute TTL) or 2× (1-hour TTL)** — writes cost *more* than
plain input, not less.

The rate card (`backend/lambdas/api/cost-calc.ts`) priced input, output and cache read. It had no cache-write rate, and
`TokenCounts` had no cache-write field, so every pricing path multiplied cache-write tokens by nothing:

| Measured at detection (all time) | |
|---|---|
| Cache-write tokens, never priced | **1.243 billion** |
| Their cost at the published 5-minute rate | **≈ $10.3 k** |
| Spend the dashboard showed | $14.4 k |
| Understatement | **≈ 70 %** |

The "Saved by prompt caching" KPI compounded it: it reported what cache *reads* saved against full input price
($12,149 on a 30-day window whose shown spend was $1,739) with no deduction for what the cache *writes* cost.

## Root cause

**A framing error at design time, propagated by code reuse, invisible to consistency checks.**

1. **Origin.** Feature-03 (2026-06-04) was "a prompt-cache *savings* KPI". The story was that caching saves money, so the
   card gained `cacheReadPerToken` for the saving and nothing for the write. The parser already extracted
   `cacheWriteInputTokenCount` and the hourly USAGE rollup stored `cacheWriteTokens`; the kind was known, just never
   priced.
2. **Propagation.** The MODEL, PROJECT and PROJDAY rollup writers — the three every pricing surface reads — were written
   later by copying the hourly writer's three-counter ADD list (`inputTokens, outputTokens, cacheReadTokens, invocations`)
   and dropping `cacheWriteTokens`. From then on the unpriced kind was also absent from every table pricing reads, so no
   one working on Cost, Overview, Projects, DORA or ROI ever saw a cache-write number next to a price.
3. **One card, nine consumers.** Cost, Overview, Projects (fast and Athena), DORA $/merge, ROI, the runaway guard and
   two Athena SQL templates all call `computeModelCost` or copy its three constants. The cross-page reconciliation built
   in feature-27 (Cost = Overview to the cent) therefore proved **consistency, not completeness** — every page was wrong
   by the same amount, and agreeing pages look right.
4. **No completeness check anywhere.** Tests pinned rate *values*; none compared the set of token kinds the parser
   extracts with the set the card prices. `parse.test.ts` even set `cacheWriteInputTokenCount: 5` in its fixture and
   never asserted it. The UI qa agent compares pages with each other and with the page's own disclosures — never with an
   external bill.
5. **The external anchor was blind.** The Budget tile (AWS Budgets) and Cost Explorer read **$0** for Bedrock in this
   account because a payer account is billed. We explained that away on the tile ("no direct billing") instead of
   treating it as "no external truth is available here — reconcile from the payer account".
6. **Copy reinforced the frame.** "billing discounts them", "the cheapest tokens you can buy", "~89 % lower than full
   input pricing" — each true of reads, each silent about writes.
7. **Reviewer blind spot.** In feature-27 the author of this document moved `cacheSavingsUsd` into Overview, sat next to
   `computeModelCost`, saw a cache-read rate and no write rate, and took it for a settled decision rather than checking
   the pricing page.

## Why it was found now

The ingestion owner, scoping unrelated rate-card work, listed every token kind the parser extracts against every column
of the card — the first time anyone did a *completeness* comparison rather than a *consistency* one. The gap was
obvious the moment the two lists sat side by side.

## Timeline

| When | What |
|---|---|
| 2026-06-04 | Feature-03 adds the rate card with input / output / cache-read; parser extracts cache-write; hourly rollup stores it |
| 2026-07 → 09 | MODEL / PROJECT / PROJDAY rollups, Cost, Overview, Projects, DORA, ROI built on the three-kind card |
| 2026-09-23 | Feature-27 reconciles Cost = Overview to the cent — consistent, both missing cache writes |
| 2026-10-05 | Ingestion owner's inventory finds the gap; owner informed; root cause researched (this doc); plan approved |
| 2026-10-06 | Published rates confirmed from the AWS Price List API: 1.25× / 2× input on every Claude model; 33/33 existing rates on the card match the list |
| feature-36 | Rate card, rollups, backfill, every consumer price cache writes; `cacheNetUsd` added |
| feature-37 | Copy and docs corrected; completeness and rollup-coverage tests; Price List drift script; payer-account reconciliation runbook |

## Published rates used for the fix (AWS Price List, `AmazonBedrockFoundationModels`, us-east-1, global route, 2026-10-06)

| Model | Input | Output | Cache read | Cache write 5 m | Cache write 1 h |
|---|---|---|---|---|---|
| Claude Fable 5.1 | $10 | $50 | $0.25 | **$12.50** | **$20** |
| Claude Fable 5 | $10 | $50 | $1.00 | **$12.50** | **$20** |
| Claude Mythos 5.1 | $10 | $50 | $0.25 | **$12.50** | **$20** |
| Claude Opus 5.5 | $4 | $20 | $0.20 | **$5.00** | **$8** |
| Claude Opus 5 / 4.8 | $5 | $25 | $0.50 | **$6.25** | **$10** |
| Claude Sonnet 5.5 / 5 | $2 | $10 | $0.20 | **$2.50** | **$4** |
| Claude Sonnet 4.6 | $3 | $15 | $0.30 | **$3.75** | **$6** |
| Claude Haiku 4.5 | $1 | $5 | $0.10 | **$1.25** | **$2** |

(per million tokens; `backend/scripts/check-rate-card.ts` reproduces this table live)

## What changes for readers

- Every spend figure rises; the 30-day and all-time totals roughly double or more depending on cache mix. ROI
  percentages fall and some projects flip to "not computable" (investment exceeds value) — the ROI page already words
  that case.
- "Saved by prompt caching" becomes **"Net effect of prompt caching"** = read savings − write premium, and can be
  negative for a workload that writes more than it re-reads.
- The estimate remains a **disclosed lower bound** until the standard-route (us./geo cross-region, ~×1.1) correction
  lands in its own chain: expect the figure to be ~9 % under the bill, and the page says so.

## Guards added (feature-37)

| Guard | What it catches |
|---|---|
| `backend/lambdas/api/pricing-completeness.test.ts` | a token kind the parser extracts that the card does not price (derived from `parse.ts`, so a new kind fails until priced or allow-listed with a reason) |
| `backend/lambdas/ingestion/rollup-fields.test.ts` | a rollup writer or maintenance script whose ADD list omits a counter its aggregate carries; any rollup shape carrying fewer counters than the hourly one |
| `backend/scripts/check-rate-card.ts` | drift between the card and the AWS Price List (manual; CI once the role has `pricing:GetProducts`) |
| `docs/RECONCILIATION.md` | monthly payer-account Cost Explorer vs dashboard comparison — the external truth this account cannot see |
| qa rule request | "every token kind shown on Usage is also priced on Cost" |

## Lessons

- **Consistency is not correctness.** Reconciling pages that share one formula proves the formula is applied evenly,
  nothing more. Completeness needs its own check, against the source of the data, not against another consumer.
- **"Discount" framing hides premiums.** A feature named for the saving will not ask what the saving cost.
- **A $0 external anchor is a missing anchor, not a reassuring one.** Say so on the page and reconcile where the bill
  actually lives.
- **Copying a field list is a design decision.** Three writers copied four counters out of five; a test that compares
  writers to their aggregate would have failed on the first one.
