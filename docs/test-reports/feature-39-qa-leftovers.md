# Feature 39 — the three qa findings no chain owned

- **Chain:** `intent/qa-leftovers/` · **Branch:** `feat/qa-leftovers` off `main@bc366b3` (post-#71) · **PR:** #TBD
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

## Known limits, stated rather than fixed
- Cold `/v1/quotas` requests still take ~7 s (Service Quotas pagination has no name filter).
- Zero-filled rows now appear in the Usage table — a quiet day is information, not noise.
- F-PR69-008 (a tracked repository went private; the collector's token gets 404) is an operations item for the owner.
