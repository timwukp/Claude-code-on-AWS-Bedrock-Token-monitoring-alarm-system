# Feature 39 — the three qa findings no chain owned

- **Chain:** `intent/qa-leftovers/` · **Branch:** `feat/qa-leftovers` off `main@bc366b3` (post-#71) · **PR:** #72
- **Origin:** qa F-PR69-003 (`/dora` axis), F-PR69-007 (`/usage` axis), F-PR68-004 (`/v1/quotas` 6–11 s) — red on every
  PR since #68 because each sat outside the active chain's plan.
- **Date:** 2026-10-11/12
- **Verdict:** PASS on gates, live measurement and the served bundle — after one deploy that broke `/v1/quotas` for
  ~40 minutes (below). qa's browser re-verification is left to the PR.

## What this report has to say plainly
- **`/v1/quotas` went from 6–11 s to 0.3–0.6 s warm.** Two causes removed: the handler summed tokens one model at a
  time (four CloudWatch calls per model, serially), and it paged the bedrock service's several hundred quotas on every
  request. Now: two `GetMetricData` calls for every model, and a ten-minute in-container cache of the quota list. The
  cold start (first request on a new container) still pays the quota pages: ~7 s.
- **The first deploy of the batched handler returned 500 for about 40 minutes.** The role allowed
  `GetMetricStatistics` and `ListMetrics`, not `GetMetricData`. I had verified the new handler locally against live
  CloudWatch — under my own credentials, which have the action — so the check never exercised the Lambda's role. The
  fix is one action on the existing read-only statement; the lesson is that a probe must run under the identity the
  code will run under, or it proves nothing about permissions.
- The two axis fixes are what they look like: one unit per axis, and a time axis that no longer deletes quiet days.

## Scope
| File | Change |
|---|---|
| `frontend/src/lib/format.ts` | `hourAxis(maxHours)` → ticks on whole-day multiples (labels `Nd`) once the series reaches 48 h, whole hours below; the previous per-tick formatter switched unit mid-axis ("25h, 2d, 3d, 4d") |
| `frontend/src/pages/DoraPage.tsx` | lead-time `YAxis` uses `hourAxis` |
| `frontend/src/pages/UsagePage.tsx` | `fillBuckets` emits every hour/day in the window with zeros where the API returned nothing; applied after `bucketDaily` |
| `backend/lambdas/api/quotas.ts` | `sumTokensBatch` (two `GetMetricData` calls, two queries per model, 500 per call); `listTokenQuotas` memoised for 10 min |
| `infra/lib/stacks/api-stack.ts` | `cloudwatch:GetMetricData` on QuotasFn's read-only statement |

## Gates
| Gate | Result |
|---|---|
| Backend `jest` / `tsc --noEmit` | PASS — 370/370 |
| Frontend `tsc --noEmit` / `vite build` | PASS |
| `cdk synth -c env=ci` | PASS |
| `sdlc_ci_gate.py --require-active` | PASS — 5 source files, all named in the plan; approval bound to `bc366b3` |

Helpers checked by hand (the frontend has no test runner): `fillBuckets` on an 8-day window with two populated days →
8 buckets `0 0 5 0 0 7 0 0`; on an hourly 03:30→07:10 window with one populated hour → 5 buckets `0 0 3 0 0`.
`hourAxis(100)` → ticks 0/24/48/72/96/120 labelled `1d…5d`; `hourAxis(9)` → 0/2/4/6/8/10 labelled `2h…10h`.

## `/v1/quotas` — measured on the deployed Lambda (CloudWatch REPORT lines)
| Build | Cold | Warm |
|---|---|---|
| Before (main at `bc366b3`, 10-08 → 10-10) | — | 6.1 s, 6.1 s, 8.8 s, 10.6 s, 11.0 s |
| Parallel `GetMetricStatistics` per model (first cut, deployed 10-11) | 7.5 s | 2.7 s, 2.4 s, 2.3 s |
| Two `GetMetricData` calls, **before the IAM fix** (deployed 10-12 04:29Z) | — | **500 AccessDenied**, ~0.2–0.3 s |
| Two `GetMetricData` calls + `GetMetricData` grant (deployed 10-12 ~05:10Z) | 7.0 s | **0.56 s, 0.41 s, 0.34 s, 0.28 s** |

Rows: 12/12 identical to the previous build's (same quota names and limits; `used` differs only by the minute/day that
has elapsed). The cold figure is the quota-list pagination; the cache serves every later request on that container.

## Served bundle (CloudFront, invalidation completed; `assets/index-C3lt3QDt.js`)
Contains the minified `fillBuckets` (`864e5:36e5`, `T00:00:00Z` bucket keys) and `hourAxis` (`Math.round(u/24)}d`).
Browser render left to qa's run on the PR.

## qa round 1 on the PR (head `edf74b0`) — 2 findings, both fixed in `769764e`
| Finding | Verdict | Action |
|---|---|---|
| F-PR72-001 MEDIUM `/roi`: unstaffed projects credited +$18,750/yr time saved while the card said ROI was refused | Real, and this author's from feature-14: the composite percentage was refused without the project's own staffing, but `value.timeSaved` (and `investment.training`) were still computed from the shared default | Both components are 0 with a "Not computed" note and no `teamSize` in their inputs; `value.totalUsd` excludes them. Test 6d extended. Live after the owner's RoiFn deploy (10-13 08:02Z): 21 projects, every unstaffed one `timeSaved` = 0 / `training` = 0; the one staffed project keeps $50,000 and 17.8% |
| F-PR72-002 LOW `/projects`: "Total tokens" excludes prompt-cache tokens without saying so | Real: Overview's token figure counts all four kinds since feature-37; Projects counts input + output | The tile's foot now states the definition. Bundle `index-D9nx_nib.js` |

## qa round 2 on the PR (head `abd954c`) — 1 finding, fixed in `ed5573f`
| Finding | Verdict | Action |
|---|---|---|
| F-PR72-003 MEDIUM `/roi`: unstaffed projects still carried a borrowed adoption-dip cost ($5,625/yr) in INVESTMENT/YR, and VALUE/YR read "+$0" instead of a withheld marker | Real — the third exit of the same hole: the J-curve term multiplies by the same borrowed teamSize × loaded cost | The dip is withheld too; `RoiResult.staffed` exposed; the table reads "withheld" for VALUE/YR and marks INVESTMENT/YR as measured spend only. Live after the RoiFn deploy (10-13 08:59Z): 21 projects, 20 unstaffed → time saved / training / dip all $0 and investment = measured AI spend exactly; the staffed one keeps $50,000 / $15,000 dip / 17%. Mutation (guard removed) fails test 6d. Bundle `index-r9ngRiML.js` |

## qa round 3 on the PR (head `d4ab9dc`) — 2 LOW findings, fixed in the next commit; F-PR72-003 confirmed fixed
| Finding | Verdict | Action |
|---|---|---|
| `/costs` negative currency reads "$-0.19" | Real: `fmtUsd` interpolated the signed number after the `$` | Sign first: "−$0.19"; a value rounding to 0.00 prints "$0.00" |
| `/usage` cache KPI says reads bill at a flat 0.1× while the Cost page says 0.025×–0.1× per model | Real: the caption pre-dated the per-model wording fixed on `/costs` in #69 | Caption now says "at each model's cache-read rate (0.025×–0.1× input)". Bundle `index-CVMOosYj.js` |

## Known limits, stated rather than fixed
- Cold `/v1/quotas` requests still take ~7 s (Service Quotas pagination has no name filter).
- Zero-filled rows now appear in the Usage table — a quiet day is information, not noise.
- F-PR69-008 (a tracked repository went private; the collector's token gets 404) is an operations item for the owner.
