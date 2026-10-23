# Reconciling the dashboard with the AWS bill

The dashboard's spend figures are **estimates**: token counts from Bedrock invocation logs × a hand-written rate card.
Every page shares that one formula, so the pages agree with each other by construction — which means **agreement between
pages proves nothing about correctness**. The 2026-10 incident (`docs/incidents/2026-10-cache-write-omission.md`) was a
~70 % understatement that every cross-page check passed. The only check that can catch that class of error is a
comparison with the bill itself. This runbook is that comparison.

## Where the bill is (corrected 2026-10-16)

An earlier version of this runbook said Cost Explorer in the monitored account reports **$0** for Bedrock and the bill
exists only in the payer account. That was a filter mistake, not a billing fact: the check filtered SERVICE =
"Amazon Bedrock", and **every Claude and OpenAI model line bills under SERVICE "Amazon Bedrock Service"** (MTD 2026-10:
$4,385.80); "Amazon Bedrock" carries Guardrails and Nova ($0.82). The same mistake sat in the Budget's CostFilters, so
the budget — and the Budget Action hard-stop built on it — watched 0.02% of the spend and read "on track" at 4.4× the
limit (qa F-PR73-006, fixed in feature-40). Cost Explorer in this account has the whole bill; the daily collector
(`BillCollectorFn`) reads it with SERVICE ∈ {"Amazon Bedrock Service", "Amazon Bedrock"} and the `bill` block on
`/v1/costs` is the reconciliation. The payer-account path below remains valid only for an account **without** Cost
Explorer access.

## Cadence

Monthly, after the 3rd of the month (AWS finalises the previous month's usage by then), plus once immediately after any
change to `backend/lambdas/api/cost-calc.ts`.

## Procedure (≈ 15 minutes)

1. **Bill side — payer account.** For the previous calendar month, filtered to the monitored account:
   ```bash
   aws ce get-cost-and-usage --profile <payer> \
     --time-period Start=2026-09-01,End=2026-10-01 --granularity MONTHLY --metrics UnblendedCost \
     --filter '{"And":[{"Dimensions":{"Key":"SERVICE","Values":["Amazon Bedrock"]}},
                       {"Dimensions":{"Key":"LINKED_ACCOUNT","Values":["<monitored-account-id>"]}}]}' \
     --query 'ResultsByTime[0].Total.UnblendedCost.Amount'
   ```
   If the `tums-project` cost-allocation tag has been activated in the Billing console (see
   `infra/lib/stacks/projects-stack.ts`), add `--group-by Type=TAG,Key=tums-project` for a per-project split.

2. **Dashboard side — monitored account.** Same month, from the API (admin token) or the Cost page with the matching
   window:
   - `GET /v1/overview?window=mtd` on the 1st, or sum `/v1/overview` daily points for the month;
   - `GET /v1/costs` for all-time; the Cost page footer shows the same figure.
   Record `totalEstimatedUsd`, `totalCacheWriteUsd`, `totalCacheNetUsd` and, if present, `totalEstimatedUsdUpperBound`.

3. **Compare.**

   | Difference (bill − estimate) / bill | Reading |
   |---|---|
   | within **±3 %** | healthy — the known residuals explain it (see below) |
   | **> +12 %**, estimate low | a token kind or a model is unpriced or under-priced → run `npx tsx backend/scripts/check-rate-card.ts`; then compare `/v1/usage` token totals per kind with the bill's usage-type lines |
   | estimate **high** by > 3 % | a rate on the card is above the published one, or usage is double-counted → `check-rate-card.ts`, then the PROJDAY-vs-hourly day comparison in `feature-19b`'s report |

4. **Record** the two numbers, the difference and the reading in `docs/incidents/` (append to the current year's
   reconciliation log; create `docs/incidents/reconciliation-log.md` on first use).

## Unlogged spend (Bedrock Mantle) — read the `bill` block first
Since 2026-10-06 Bedrock Mantle traffic bills under the ordinary usage types but never reaches the invocation logs
(`docs/research-mantle-unlogged-spend.md`). The daily collector (`BillCollectorFn`) stores Cost Explorer's lines as
`BILL#DAILY`; `/v1/costs.bill` compares, per model and per billed day, the bill with what the logs price and names the
difference **not logged**. So the monthly comparison above is now two numbers: the rollups should match the bill's
`loggedEstimateUsd`, and `totalUnloggedUsd` is the Mantle share — explained by its CloudWatch inferences, never priced
from its tokens (no cache split there). A rising unlogged share is not a pricing defect; a non-zero `overEstimated` flag is.

## Known residuals (expected, disclosed on the pages)

- **Route tiers are priced (feature-38).** The card holds the global tier; `routeMultiplier()` applies the standard tier
  (×1.1) to `us.`/geo cross-region, inference-profile and direct calls, and 1 to `global.` calls and single-tier models
  (Amazon Nova). A residual here would mean a route the rule does not recognise — check the model ids on the Cost page.
- **Unknown-TTL cache writes.** Where the logged response body carries no 5 m / 1 h split, writes are priced at the
  5-minute rate with a 1-hour upper bound (`estimatedUsdUpperBound`).
- **Unresolved inference-profile ids** are reported `unpriced: true` and excluded; the Cost page lists them.
- **Models the card cannot price** (feature-41) are listed as `unpricedModels` on `/v1/costs`, `/v1/overview`,
  `/v1/projects` and rendered on the pages; they sit in every total at $0. Add the published rate to the card.
- **Models the bill charged $0.00 for** (feature-41) — on this account every OpenAI model so far (whole bill
  2026-06-01 → 10-22, every service: $0 lines with non-zero quantity, none at all for gpt-5.6-sol). The card still prices
  them at the published model-card rates, because another account is charged them; the bill panel marks the row
  `billedZero` and sums the list-price surplus (`billedZeroEstimateUsd`). Reconcile the Claude rows to ≤ 0.1%; do not
  expect OpenAI rows to reconcile until the bill carries a non-zero line for them. The logged share is Σ min(billed,
  logged) per model, so a surplus on one model cannot "explain" another model's bill.
- **Long-context OpenAI calls** (> 272K input tokens) bill at 2× input / cache and 1.5× output per the model cards;
  the rollups cannot tell them apart, so the estimate is a floor for such calls.
- **Bill rounding and credits** — the bill is net of any credits; the estimate is gross.

## What a clean reconciliation does not prove

That the *attribution* (which project a dollar belongs to) is right — that is `docs/ATTRIBUTION.md`'s concern and is
checked by the Projects page's Fast-vs-Full comparison. This runbook checks the **total** only.
