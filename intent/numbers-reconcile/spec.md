# Spec: every figure reconciles with the one beside it

- **Intent:** ./intent.md
- **Author:** Claude (AI agent)
- **Accepted-by:** Tim WU
- **Status:** shipped

## 1. /roi — one day-count basis
`roi-calc.ts` exports `DAYS_PER_YEAR = 365` and `DAYS_PER_MONTH = DAYS_PER_YEAR / 12`. Annual = window spend × 365/window,
and monthly = window spend ÷ window × 365/12, so `round(monthly × 12) === annual` for any window. `roi.ts` uses the same
constant for `monthlySpendUsd`. `aiSpend.formulaInputs` gains `windowDays`. The diagram reads "$X in N days × 365/N"
and the ROI card reads "(× 365/N; monthly = annual ÷ 12)". Neither shows a rounded factor.

## 2. /latency By model — ranked, with a remainder row
- Pass 1: one `SampleCount` query per listed ModelId. `rankModelIds` drops zero-sample series, sorts by samples
  descending (ties by id) and keeps the top 12. Pass 2 fetches full statistics for the fleet plus those 12.
- `fetchSeries` chunks at 500 queries (the GetMetricData limit) and follows NextToken. `ListMetrics` follows NextToken.
- `modelRemainder` = fleet samples − shown samples, with a note naming what it holds: series ranked out, and series
  ListMetrics no longer lists (two-week listing horizon). A negative remainder says the rows ran N ahead.
- The page adds the remainder as the last table row, and the panel description says the column sums to the fleet
  figure. The "burst" wording goes.

## 3. Fast-only latency; rate card
- `projects.storageNote` states that per-project latency is Fast-only and why Athena cannot read it. The By project
  panel shows it.
- RATE_CARD adds rows above their family rows (AWS Price List, AmazonBedrockFoundationModels, us-east-1, Global
  standard, per MTok): `fable-5-1` 10/50/0.25 · `mythos-5-1` 10/50/0.25 · `opus-5-5` 4/20/0.2 · `sonnet-5-5` 2/10/0.2 ·
  `sonnet-5` 2/10/0.2. A test asserts that no row is shadowed by an earlier row whose key it contains.
- Cost is computed at read time from stored tokens, so this reprices history. The CHANGELOG states the measured change.

## 4. Account vs tenant
`accountVsTenant(fleetE2eSamples, tenantInvocations)` returns both counts, the tenant's share and a note with all three
numbers and the cause. The page shows it directly under the fleet tiles with an `account-wide` chip. `scopeNote` opens
with "Account-level: every caller in the AWS account, not only this tenant."

## 5. /dora banner
"{prCount} merged PRs stored for this repo since collection began, not only this window". No API change.

## 6. /projects Full vs Fast
In the Full view the panel description appends the live figure: "Right now the Athena rows total $X, $D (P%)
above/below the rollups' $Y as of HH:MM UTC." Both sides are all-time. The KPI foot is unchanged.

## Out of scope
Athena latency; cache-write pricing; `/costs` id counts; any other page.
