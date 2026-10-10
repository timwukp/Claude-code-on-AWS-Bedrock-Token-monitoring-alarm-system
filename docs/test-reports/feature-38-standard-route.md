# Feature 38 — the standard route is priced; the estimate stops being a lower bound

- **Chain:** `intent/standard-route/` · **Branch:** `feat/standard-route` off `main@10d3296` (post-#70) · **PR:** #71
- **Origin:** the owner's decision of 2026-10-05 to ship the ×1.1 route correction after feature-36, and the peer's
  request (feature-37) to remove the "lower bound" sentences once it lands.
- **Date:** 2026-10-10
- **Verdict:** PASS on gates and the bill reconciliation (+0.02% in total, every token kind within 0.6%); live and the
  served bundle are recorded below after the owner's deploy.

## What this report has to say plainly
- **The estimate now reproduces the bill.** Over 2026-06-04 → 10-05 (the window both sources fully cover) the card
  with the route factor gives **$33,040.54 against Cost Explorer's $33,033.63 (+0.02%)** across all tenants, all
  models, all four token kinds. The two residuals that remain are named below and are not pricing errors.
- **Every standard-route tenant's figures move +10% at once.** The largest tenant goes from $25,540.84 to $28,094.61 for
  2026-06-01 → 10-05 — every one of its calls is on a `us.` route, so the whole figure takes the standard tier. A
  tenant on `global.` routes does not move.
- **The caveat is gone because it is no longer true,** not because it was inconvenient: Cost page note, Overview spend
  tile, both help entries, `RECONCILIATION.md`. The incident record keeps its bullet, struck through and marked resolved.

## The route rule
| Model id as stored (ARN prefix stripped) | Factor | Why |
|---|---|---|
| `global.anthropic.…`, `global.openai.…` | 1.0 | the card's own tier ("Global standard") |
| `us.…`, `eu.…`, `apac.…` | 1.1 | geo cross-region profiles bill at "standard" |
| bare `anthropic.…` / `openai.…` | 1.1 | a direct single-region call, or an inference profile resolved to its model — both "standard" |
| `amazon.nova-micro…` (any prefix) | 1.0 | one tier on the list (`routeTiers: false`) |

Price List evidence (us-east-1, read 2026-10-08/10): Sonnet 5.5 `input_tokens_global_standard` $2.00 vs
`input_tokens_standard` $2.20 per MTok; GPT-6 Astra $10.00 vs $11.00 — OpenAI models on Bedrock carry the split too.
`USE1-NovaMicro-*` has no tier suffix.

## Scope
| File | Change |
|---|---|
| `backend/lambdas/api/cost-calc.ts` / `.test.ts` | `STANDARD_ROUTE_MULT`, `ModelRate.routeTiers`, `routeMultiplier()`, `routeCaseSql()`, `ModelCost.routeMultiplier`; every dollar figure × factor; 12 new cases; rate-arithmetic fixtures moved to `global.` ids so their expected dollars still read off the card |
| `backend/lambdas/api/cost-calc-openai.test.ts` | the `us.openai` fixture expects the standard tier |
| `backend/lambdas/api/queries.ts` / `.test.ts` · `projects.ts` / `projects-sql.test.ts` | route CASE around the four rate terms (`byProject`, grouped by model) and inside the SUM (`buildFullSql`, grouped by project) |
| `overview-calc.test.ts`, `project-calc.test.ts`, `roi-calc.test.ts` | fixtures on `global.` ids; the "regional variants" test now asserts $1 + $1.10 |
| `frontend/src/pages/CostsPage.tsx`, `OverviewPage.tsx`, `lib/help-content.ts`, `api/client.ts` | caveats → the route rule; `routeMultiplier?` type |
| `docs/RECONCILIATION.md`, `docs/incidents/2026-10-cache-write-omission.md` | table row and residual replaced by the rule; incident bullet resolved |

## Gates
| Gate | Result |
|---|---|
| Backend `jest` / `tsc --noEmit` | PASS — 370/370, 27 suites (was 336 at #69 merge + feature-37's additions) |
| Frontend `tsc --noEmit` / `vite build` | PASS |
| `cdk synth -c env=ci` | PASS — infra untouched |
| `sdlc_ci_gate.py --require-active` | PASS — every source file named in the plan; approval bound to `10d3296` |

### Mutations (each restored after the run)
| Mutation | Tests failing |
|---|---|
| route factor forced to 1 in `computeModelCost` | 4 |
| bare ids treated as global (factor 1) | 1 |
| single-tier rows given 1.1 | 1 |
| `cacheNetUsd` left unscaled | 1 |

## Bill reconciliation — BEFORE any deploy
Athena per model, 2026-06-04 → 10-05 (logs begin 06-03T06:54Z), priced with the new card, versus Cost Explorer
`UnblendedCost` by usage type (SERVICE "Amazon Bedrock Service" / "Amazon Bedrock", all pages), split by model × route ×
token kind:

| Model (route) | Input | Output | Cache read | Cache write | Total est. / billed |
|---|---|---|---|---|---|
| fable-5 (standard) | 30.35 / 30.33 | 1,898.06 / 1,898.06 | 6,231.94 / 6,244.47 | 7,098.56 / 7,099.64 | 15,258.92 / 15,272.51 (−0.09%) |
| fable-5 (global) | 3,315.87 / 3,320.81 | 780.16 / 796.89 | 0.02 / 0.02 | 0.14 / 0.14 | 4,096.18 / 4,117.85 (−0.53%) |
| opus-5 + opus-4-7 (standard)¹ | 51.50 / 51.52 | 1,980.41 / 1,980.32 | 3,776.25 / 3,779.01 | 2,362.64 / 2,363.50 | 8,170.80 / 8,174.36 (−0.04%) |
| sonnet-4-6 (standard) | 21.72 / 21.72 | 45.91 / 45.91 | 1,125.22 / 1,125.19 | 881.57 / 881.56 | 2,074.42 / 2,074.39 (0.00%) |
| fable-5-1 (standard) | 3.89 / 3.89 | 129.09 / 129.09 | 199.08 / 199.23 | 1,427.45 / 1,427.55 | 1,759.52 / 1,759.76 (−0.01%) |
| opus-4-8 (standard) | 0.51 / 0.51 | 23.10 / 23.07 | 235.23 / 236.21 | 375.22 / 375.22 | 634.07 / 635.01 (−0.15%) |
| sonnet-4-6 (global) | 378.87 / 378.33 | 22.94 / 22.89 | — | — | 401.81 / 401.22 (+0.15%) |
| opus-4-8 (global) | 162.53 / 162.53 | 6.59 / 6.59 | — | — | 169.13 / 169.13 (0.00%) |
| haiku-4-5 (standard) | 112.50 / 112.50 | 17.00 / 17.00 | 0.14 / 0.14 | 5.05 / 5.05 | 134.69 / 134.69 (0.00%) |
| opus-5-5 (standard) | 0.18 / 0.18 | 17.59 / 17.59 | 17.63 / 17.63 | 63.44 / 63.44 | 98.84 / 98.84 (0.00%) |
| opus-5 (global) | 76.16 / 76.16 | 18.79 / 18.79 | — | — | 94.95 / 94.95 (0.00%) |
| sonnet-5-5 (global) | 72.74 / 72.74 | 3.30 / 3.30 | — | — | 76.05 / 76.05 (0.00%) |
| sonnet-5 (global) | 19.29 / 20.71 | 1.82 / 3.08 | — | — | 21.11 / 23.80 (−11.3%, $2.69) |
| gpt-5.6-sol (standard) | 0.06 / — | 47.46 / — | — | 2.54 / — | 50.06 / — ² |
| opus-4-6 (standard) | — / 0.00 | — / 0.31 | — / 0.24 | — / 0.52 | — / 1.07 ³ |
| **By kind** | **4,246.19 / 4,251.95 (−0.14%)** | **4,992.23 / 4,962.89 (+0.59%)** | **11,585.51 / 11,602.15 (−0.14%)** | **12,216.62 / 12,216.63 (−0.00%)** | **33,040.54 / 33,033.63 (+0.02%)** |

¹ The card's `opus` family row matches `opus-4-7` as well as `opus-5` (same list rates, $5 / $25); Cost Explorer bills
them as two usage types, so the two lines are summed to compare like with like. Separately they read +2.07% and −100%.
² Cost Explorer carries no line of any kind for the GPT model under the Bedrock service filter (feature-36 finding); the
$50.06 is the card's figure and cannot be checked against this bill.
³ Opus 4.6: $1.07 billed, no logged tokens in the window.

The two real residuals: **fable-5 global output −$16.73 (−2.1%)** and **sonnet-5 global −$2.69 (−11%)** — both on the
`global.` route, both small, both the estimate *under* the bill; the logs may miss a few global calls (the feature-36
backfill found one object whose GET aborted), or the bill may include calls outside the logging scope. They total
$19.42 on $33,034 (0.06%) and are stated, not folded.

Repricing of stored tokens for 2026-06-01 → 10-05, all tenants: $30,555.09 → $33,124.66 (+8.41%); largest tenant
$25,540.84 → $28,094.61 (+10.00%, all `us.` routes); a tenant on `global.` routes only: unchanged.

## Live — dev, `Tums-dev-Api` deployed by the owner 2026-10-10 (7 Lambdas, code only)
Deployed Lambdas invoked directly with an API-Gateway event carrying the tenant's `custom:tenantId` and `admin` claims.

| Check | Result |
|---|---|
| `/v1/costs` all-time, largest tenant | **$28,524.16** (was $25,790.83 on 10-09 under feature-36's card; +10.6% with three more days of traffic); cache read $11,687.68, cache write $12,584.24; 28 rows |
| `routeMultiplier` per row | present on every row; values {1, 1.1}. `us.anthropic.claude-fable-5` ×1.1 $15,256.66 · `us.…opus-5` ×1.1 $8,000.49 · `us.…sonnet-4-6` ×1.1 $2,074.13 · `anthropic.claude-fable-5-1` (profile-resolved, bare) ×1.1 $1,956.68 |
| `global.` rows | ×1 and unchanged (`global.anthropic.claude-fable-5`, `global.…haiku-4-5`, `global.…opus-4-6`) |
| single-tier | `amazon.nova-micro-v1:0` ×1 |
| `/v1/overview?window=7` | 200; spend $542.17; `rollupsLastRunAt` 2026-10-10T06:51:44Z |
| one cosmetic finding from the live read | an unknown model (`amazon.nova-pro`, $0 on the card) reported ×1.1 on a $0 row; `ZERO_RATE` now carries `routeTiers: false` so unknown models report ×1 (commit after the deploy; needs the final code-only redeploy to show live) |

## Served bundle (CloudFront, invalidation completed; `assets/index-6x_eSv8y.js`)
Present: "standard tier, ×1.1" (Cost note), "routes priced (global tier, standard ×1.1)" (Overview tile). Absent: "Not
yet applied", "treat these figures". The one remaining "lower bound" string in the bundle is the Latency page's
open-ended-bucket chip, which is about histogram buckets and stays. Browser render left to qa's run on the PR.

## Known limits, stated rather than fixed
- GPT "long context" tiers (2× on the Price List) are not priced; this account has no such usage on the bill.
- A route prefix the rule does not know takes the standard tier (the conservative direction today).
- The residuals above.
