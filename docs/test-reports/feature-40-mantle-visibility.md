# Feature 40 — Mantle visibility: the spend the invocation logs never see

- **Chain:** `intent/mantle-visibility/` · **Branch:** `feat/mantle-visibility` off `main@e849de8` (post-#72) · **PR:** #TBD
- **Origin:** a peer session's gateway study pointed at `AWS/BedrockMantle`; the three-source check in
  `docs/research-mantle-unlogged-spend.md` then showed that Bedrock Mantle traffic is billed but never logged.
- **Date:** 2026-10-14/15
- **Verdict:** PASS on gates, live and the served bundle. The deployed product now reproduces the research figure on
  its own: Opus 5.5 **$1,096 not logged, 5,816 Mantle inferences**; every other model's logged estimate equals the bill
  to within cents.

## What this report has to say plainly
- **Since 2026-10-06 the dashboard has been missing most of the Opus 5.5 spend.** For 2026-10-01 → 10-14 the bill is
  $3,173.98; the logs price $2,077.02; **$1,096.96 (34.6%) is not logged**, all of it Opus 5.5 through Bedrock Mantle.
  Before 10-06 the logged side equals the bill to the cent per day; after it, the daily gap tracks Mantle's daily
  inference count exactly (10-08: $538.76 billed / $179.40 logged / 2,830 inferences; 10-13: $537.00 / $536.51 / 411).
- **The headline figures were left as they are** — logged, reconcilable to the invocation logs — and the bill comparison
  sits beside them. Merging the bill into the headline would have hidden which part has project attribution and cache
  split (the logged part) and which has neither (Mantle).
- **Mantle tokens are never priced.** Its CloudWatch token metric has no cache split; ~93% of those tokens were cache
  reads on the bill, so tokens × rate would have read ≈ $6,900 against ≈ $1,100 billed. Dollars come from Cost Explorer
  through a daily collector; CloudWatch supplies the counts that explain them.
- **Two live defects were found and fixed before the PR**, neither visible to tests: (1) the readers summed every
  tenant's PROJDAY rows per page view — the account has **2,524 tenants** (every AgentCore session is its own
  assumed-role ARN) and `/v1/costs` timed out; the logged side now runs once a day in the collector and is stored.
  (2) `SYSTEM#TENANTS`, maintained by the aggregator from the tenants it sees, held 2 tenants after its first run, so
  sonnet-5-5 read "logged $0" against 309 logged calls; a one-time seed from the table's PROJDAY partitions fixed the
  bootstrap gap. Recorded as [[live-check-finds-scale-and-bootstrap-gaps]].

## Scope
| File | Change |
|---|---|
| `backend/lambdas/ingestion/bill-parse.ts` / `.test.ts` | `parseUsageType` (current and legacy usage-type schemes, region prefix, unknown → `other`), `billLinesFrom`; 16 cases on real names |
| `backend/lambdas/ingestion/bill-collector.ts` | daily `ce:GetCostAndUsage` (DAILY, 4-day lookback, all pages) → `BILL#DAILY`; computes and stores the logged side (`LOGGED#DAILY`) for the same days; `SYSTEM#BILL` |
| `backend/lambdas/shared/logged-estimate.ts` | `computeLoggedByModelDay` (every tenant from `SYSTEM#TENANTS`, bounded concurrency, profile-resolved, priced by `computeModelCost`), `storeLoggedByModelDay`, `readLoggedByModelDay` |
| `backend/lambdas/ingestion/aggregator.ts` | `recordTenants` → `SYSTEM#TENANTS` (merged set) |
| `backend/scripts/seed-tenant-index.ts` | one-time seed of `SYSTEM#TENANTS` from the table (2,524 tenants) |
| `backend/lambdas/api/bill-calc.ts` / `.test.ts` | `billModelKey`, `buildBill` (day alignment, floor + `overEstimated`, totals, `loggedSharePct`), `mantleConsistent`; 11 cases, 2 mutation checks |
| `backend/lambdas/api/bill-read.ts` | `readBillLines`, `readMantle` (Model series + fleet cross-check), `billBlockFor` |
| `backend/lambdas/api/costs.ts`, `overview.ts`, `latency.ts` | `bill` block (all stored days / page window); `mantle` block |
| `infra/lib/stacks/etl-stack.ts`, `api-stack.ts` | `BillCollectorFn` (06:30 UTC daily, `ce:GetCostAndUsage`, aggregates RW, tenants R); CostsFn/OverviewFn `cloudwatch:GetMetricData` + `ListMetrics` |
| `frontend/src/api/client.ts`, `pages/CostsPage.tsx`, `pages/OverviewPage.tsx`, `pages/LatencyPage.tsx` | "Billed vs what the logs price" panel; unlogged amount on the spend tile; `bedrock-mantle` row |
| `backend/package.json` / `package-lock.json` | `@aws-sdk/client-cost-explorer` |

## Gates
| Gate | Result |
|---|---|
| Backend `jest` / `tsc --noEmit` | PASS — 397/397, 29 suites |
| Frontend `tsc --noEmit` / `vite build` | PASS |
| `cdk synth -c env=ci` | PASS — 10 stacks |
| `sdlc_ci_gate.py --require-active` | PASS — 16 source files, all named in the plan; approval bound to `e849de8` |
| Mutations | day filter dropped → 4 tests fail; floor removed → 1 fails |

## Live — dev (owner deployed Etl twice and Api twice; both carry IAM)
`cdk diff` read before each: Etl adds `BillCollectorFn` + role + schedule, `ce:GetCostAndUsage` on `*`, aggregates RW,
tenants R; Api adds `cloudwatch:GetMetricData` + `ListMetrics` on CostsFn and OverviewFn. Lambdas invoked with an
API-Gateway event carrying the owner's `custom:tenantId` and `admin` claims.

| Check | Result |
|---|---|
| Collector, first run under its own role (log read within a minute) | 85 lines / 3 days, 2.8 s |
| Collector, manual backfill `{start: 2026-10-01, end: 2026-10-15}` | 263 bill lines / 14 days, 65 logged day-model rows over 2,524 tenants, **20.8 s**, 127 MB |
| Logged vs billed, pre-Mantle days | 10-01 $20.71 / $20.71 · 10-02 $52.39 / $52.39 · 10-03 $13.40 / $13.40 · 10-04 $12.19 / $12.19 · 10-05 $148.26 / $148.50 |
| Logged vs billed, Mantle days | 10-08 $179.40 / $538.76 (2,830 inferences) · 10-09 $107.09 / $573.91 (2,146) · 10-10 $168.63 / $402.45 (694) · 10-13 $536.51 / $537.00 (411) |
| `/v1/costs.bill` (14 billed days) | billed $3,173.98 · logged $2,077.02 · **unlogged $1,096.96 · logged share 65.4%**; opus-5-5 unlogged $1,096.03 with `mantle.inferences` 5,816; fable-5 $188.40 = $188.40, sonnet-5-5 $151.11 = $151.11, haiku $3.35 = $3.35; `mantleInconsistent` absent |
| `/v1/overview?window=30` | same block for the window; warm 0.42–0.65 s (Costs 0.63–1.0 s warm, ~2 s cold) |
| `/v1/latency.mantle` | 6,236 inferences, 0 client errors: opus-5-5 5,816 · gpt-6-luna 221 · gpt-5.6-luna 198 · gpt-6-sol 1; `inconsistent: false` |

The research figure for 10-06 → 10-13 ($1,098.16 unlogged) and the deployed figure for 10-01 → 10-14 ($1,096.96) agree
within the rounding of the two windows; 5,816 inferences in both.

## Served bundle (CloudFront, invalidation completed; `assets/index-CnuoitiL.js`)
Present: "Billed vs what the logs price", "not logged (Bedrock Mantle)", "bedrock-mantle", "latency not published by
AWS". Browser render left to qa's run on the PR.

## Known limits, stated rather than fixed
- Cost Explorer lags about a day; the panel says "bill through <day>" and compares only billed days.
- Mantle calls have no project attribution and no cache split — by the nature of the source, not a defect here.
- A Mantle hop is NOT drawn in the latency chain: Mantle is a parallel endpoint, not a stage of the logged path.
- Cost: CE API ≈ $0.5/month (1–2 requests/day); the collector's daily run ≈ 21 s at 512 MB.
