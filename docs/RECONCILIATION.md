# Reconciling the dashboard with the AWS bill

The dashboard's spend figures are **estimates**: token counts from Bedrock invocation logs × a hand-written rate card.
Every page shares that one formula, so the pages agree with each other by construction — which means **agreement between
pages proves nothing about correctness**. The 2026-10 incident (`docs/incidents/2026-10-cache-write-omission.md`) was a
~70 % understatement that every cross-page check passed. The only check that can catch that class of error is a
comparison with the bill itself. This runbook is that comparison.

## Why it must run from the payer account

In this deployment the monitored account is a **member of an AWS Organization**; Bedrock charges are billed to the
payer. Inside the monitored account, AWS Budgets and Cost Explorer therefore report **$0** for Amazon Bedrock (the
Governance page's "No billing data on this account" state). The bill exists only in the payer account's Cost Explorer,
so this runbook needs read access there (`ce:GetCostAndUsage` on the payer, or a CUR). Nothing in the repo can do this
automatically from the monitored account; it is a human (or payer-side) task.

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
   | **+5 % to +12 %**, estimate low | expected while the standard-route (us./geo cross-region ≈ ×1.1) correction is not yet applied; the Cost page states this as a lower bound |
   | **> +12 %**, estimate low | a token kind or a model is unpriced or under-priced → run `npx tsx backend/scripts/check-rate-card.ts`; then compare `/v1/usage` token totals per kind with the bill's usage-type lines |
   | estimate **high** by > 3 % | a rate on the card is above the published one, or usage is double-counted → `check-rate-card.ts`, then the PROJDAY-vs-hourly day comparison in `feature-19b`'s report |

4. **Record** the two numbers, the difference and the reading in `docs/incidents/` (append to the current year's
   reconciliation log; create `docs/incidents/reconciliation-log.md` on first use).

## Known residuals (expected, disclosed on the pages)

- **Standard-route premium (~×1.1).** The card prices the global route; calls on `us.`/geo cross-region profiles bill
  ~10 % higher. Until the standard-route chain lands, the estimate is a lower bound by roughly that share of traffic.
- **Unknown-TTL cache writes.** Where the logged response body carries no 5 m / 1 h split, writes are priced at the
  5-minute rate with a 1-hour upper bound (`estimatedUsdUpperBound`).
- **Unresolved inference-profile ids** are reported `unpriced: true` and excluded; the Cost page lists them.
- **Bill rounding and credits** — the bill is net of any credits; the estimate is gross.

## What a clean reconciliation does not prove

That the *attribution* (which project a dollar belongs to) is right — that is `docs/ATTRIBUTION.md`'s concern and is
checked by the Projects page's Fast-vs-Full comparison. This runbook checks the **total** only.
