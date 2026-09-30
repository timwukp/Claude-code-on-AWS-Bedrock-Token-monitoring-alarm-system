# Feature 34 — every figure reconciles with the one beside it

- **Chain:** `intent/numbers-reconcile/` · **Branch:** `fix/numbers-reconcile` off `main@3c60f41` (post-#66) · **PR:** #67
- **Origin:** qa findings F-PR65R3-001, F-PR66-002, F-PR66-003, F-PR66-004 (HIGH), F-PR66-005, F-PR66R2-001, and the
  owner's Latency 1c decision (state Fast-only on the page).
- **Date:** 2026-09-30
- **Verdict:** PASS on gates, live Lambda invocation on dev and the served bundle. qa round 1: 3 LOW findings, 2 fixed
  here, 1 belongs to the next chain (see below).

## What this report has to say plainly
- **The rate card change reprices history.** Cost is computed from stored tokens at read time. On dev the largest
  tenant's all-time total moves −$530.85 (−3.6%), and all tenants together move from $19,808.97 to $19,253.12. It is a
  correction: the five point releases were priced at their family rates, and `fable-5-1` cache reads at $1.00 instead
  of the listed $0.25 per MTok.
- **The /latency truncation was real, and the #64 disclosure blamed the wrong cause.** Rows were cut at 12 in
  ListMetrics order. The column did not sum to the fleet total because a series was dropped, not because of a burst.
  At 30 days two series are now ranked out. The remainder row carries their 32 invocations, and the column sums exactly.
- **The /dora prCount diagnosis from #66 did not hold.** The stored count matched a live count for all six
  repositories. qa had compared one repository's stored count with a two-repository 30-day sum. Only the label changes.
- **Not covered: a browser walk.** Gates, direct Lambda invocation and the served bundle were checked by hand. The
  rendered pages are left to qa's browser run on the PR.

## Scope
| File | Change |
|---|---|
| `backend/lambdas/api/roi-calc.ts` / `.test.ts` | `DAYS_PER_YEAR`, `DAYS_PER_MONTH = 365/12`; `windowDays` in `aiSpend.formulaInputs`; test (10b) monthly × 12 = annual |
| `backend/lambdas/api/roi.ts` | `monthlySpendUsd` on `DAYS_PER_MONTH` |
| `backend/lambdas/api/latency.ts` / `.test.ts` | `rankModelIds`, `modelRemainder`, `accountVsTenant`; paginated ListMetrics; `fetchSeries` in 500-query chunks; two-pass handler; `storageNote`; 11 new cases |
| `backend/lambdas/api/cost-calc.ts` / `.test.ts` | five point-release rows above their families; rate, family and no-shadowing tests |
| `frontend/src/api/client.ts` | response types |
| `frontend/src/components/RoiModelDiagram.tsx`, `pages/RoiPage.tsx` | "× 365/N" |
| `frontend/src/pages/LatencyPage.tsx` | account-vs-tenant line, remainder row, panel descriptions, Fast-only note |
| `frontend/src/pages/DoraPage.tsx` | banner label |
| `frontend/src/pages/ProjectsPage.tsx` | live Full − Fast difference |

## Gates
| Gate | Result |
|---|---|
| Backend `jest` / `tsc --noEmit` | PASS — 284/284, 25 suites |
| Frontend `tsc --noEmit` / `vite build` | PASS |
| `cdk synth -c env=ci` | PASS — 10 stacks |
| `sdlc_ci_gate.py --require-active` | PASS — 13 source files, all named in the plan; approval bound to `3c60f41` |
| Mutation: `fable-5` moved above `fable-5-1` | 2 tests fail (rate and no-shadowing); restored → 19/19 |

## Rate rows — AWS Price List (`AmazonBedrockFoundationModels`, us-east-1, Global standard, USD per MTok)
| Row | Input | Output | Cache read |
|---|---|---|---|
| `fable-5-1` | 10 | 50 | 0.25 |
| `mythos-5-1` | 10 | 50 | 0.25 |
| `opus-5-5` | 4 | 20 | 0.2 |
| `sonnet-5-5`, `sonnet-5` | 2 | 10 | 0.2 |

Measured repricing of the stored MODEL rollups on dev (old card → new card): `anthropic.claude-fable-5-1` $733.95 →
$256.71 · its inference-profile route $79.99 → $34.18 · `global…sonnet-5-5` $50.57 → $33.71 · `global…sonnet-5` $24.46
→ $16.31 · `us…opus-5-5` profile $15.33 → $7.53. No other model moves.

## Live — dev, `Tums-dev-Api` deployed (code-only diff, no IAM change; owner-authorised)
The deployed Lambdas were invoked directly with an API-Gateway event carrying the tenant's `custom:tenantId` and
`admin` claims.

| Check | Result |
|---|---|
| `/v1/latency?window=1` | 7 rows sum to 178; remainder 0; fleet 178 ✓ |
| `/v1/latency?window=7` | 12 rows sum to 2,225; remainder 0; fleet 2,225 ✓ |
| `/v1/latency?window=30` | 12 rows sum to 27,459; **2 series ranked out**; remainder 32; fleet 27,491 ✓ |
| Account vs tenant (7 d) | "2,225 invocations account-wide; 1,178 (53%) are this tenant's logged calls … The other 1,047 were made by other callers …" |
| Zero-remainder note | read live as "It holds series CloudWatch no longer lists" on an empty row, which is misleading. Fixed to "Nothing outside the rows above: they add up to the fleet figure.", with a test, then redeployed |
| `storageNote`, `scopeNote` | present, as specified |
| `/v1/roi/projects?window=30` and `90` | 21/21 projects: `round(windowSpend ÷ windowDays × 365/12 × 12) = aiSpend.valueUsd`, 0 mismatches |

## Served bundle (CloudFront, invalidation completed; `assets/index-C4O4qiyw.js`)
Present: "365/", "monthly = annual ÷ 12", "account-wide", "Other traffic", "adds up to the fleet figure", "since
collection began, not only this window", "Right now the Athena rows total", "busiest series by invocations".
Absent: "for a few minutes after a burst", "PRs collected", "slightly ahead of the 15-minute", "in window ×",
"because these metrics carry no project dimension".

## Known limits, stated rather than fixed
- The rate card prices no cache writes (Fable 5.1 lists $12.50 per MTok). This was true before this change as well.
- Athena has no latency: the Glue table maps no response body. The page now says so.

## qa round 1 (run 36699153705, head `8f9f08e`) — 3 LOW findings
The workflow runs with `QA_RED_ON: FAIL`, so any finding turns the check red, whatever its severity.

| Finding | Verdict | Action |
|---|---|---|
| F-PR67-002 `/latency`: the same series is named differently by window ("…opus-5-5 · us" at 7 d, bare at 30 d) | Real, and caused by this PR's ranking. The route suffix was added only when two *shown* rows shared a label. At 7 d `global…opus-5-5` (1 call) was shown beside `us…opus-5-5`; at 30 d it was ranked out, and the suffix disappeared | Every row and model button now carries its route (`us`, `global`, `direct` or the profile name), so a series keeps one name in every window |
| F-PR67-003 `/dora` Projects: REPOS = 1 beside "no repos tracked" | Real. The cell said "no repos tracked" in both cases: no repo linked, and linked repos not tracked in DORA | The cell now says "no repos linked" or "repo not tracked in DORA", the same split `project-calc.ts` already makes in its notes |
| F-PR67-001 `/costs`: duplicate model ids in a row's id list, and a "Models used" count that includes them | Real, and predates this PR. Neither `CostsPage.tsx` nor `lib/model-names.ts` is in this chain's plan | Left to the queued `cost-id-consistency` chain, which owns the id merge. The next qa run is expected to report it again |

Frontend redeployed; the served bundle `assets/index-B9XZiXTs.js` contains "repo not tracked in DORA" and "no repos
linked" and no longer contains "no repos tracked". Frontend `tsc` and `vite build` pass.
