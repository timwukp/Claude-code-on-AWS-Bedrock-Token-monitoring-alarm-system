# Test Report — Feature #2: Bedrock token-quota / throttle monitoring

| | |
|---|---|
| Issue | #2 |
| Branch | `feat/token-quota-monitoring` |
| Date | 2026-06-04 |
| Environment | Real AWS account, `us-east-1` (placeholder account id in docs) |
| Result | **PASS** — unit tests + real-AWS end-to-end |

## Scope

Surface Bedrock token-quota headroom (per-model tokens-per-minute and max-tokens-per-day) and
throttle status in the API and dashboard, so a scaling pilot does not silently hit HTTP 429
limits. Adds `GET /v1/quotas`, a pure `quota-calc` module, and a quota panel on the Usage page.

## Unit tests

Command: `cd backend && npm test`

| Suite | Tests | Result |
|---|---|---|
| `quota-calc.test.ts` (new) | 7 | PASS |
| `cost-calc.test.ts` | 7 | PASS |
| `parse.test.ts` | 7 | PASS |
| `queries.test.ts` | 4 | PASS |
| **Total** | **25** | **PASS** |

Key cases for this feature:
- `computeHeadroom` — remaining/percent for normal usage; warn ≥70%, critical ≥90%; never
  negative or >100% past the limit; safe with a zero/unknown limit.
- `summarizeThrottles` — **missing datapoints treated as zero** (the normal, healthy case, since
  `InvocationThrottles` has no datapoints until a 429 actually occurs).
- `windowOf` — classifies per-minute vs per-day quota names.

## Build / synth gates

- `cd backend && npx tsc --noEmit` → PASS
- `cd frontend && npm run build` → PASS
- `cd infra && npx cdk synth --context env=ci` → PASS

## Real-AWS end-to-end validation

Deployed `Tums-dev-Api` (added `QuotasFn` with read-only `cloudwatch:GetMetricStatistics` +
`servicequotas:ListServiceQuotas`). Called `GET /v1/quotas` with a real Cognito JWT.

Observed (real data):
- `throttles`: `throttled=false, throttledCount=0, clientErrors=6`
  - `InvocationThrottles` had **no datapoints** → correctly reported as 0 (healthy), not an error.
  - `InvocationClientErrors` = 6 over 24h (real CloudWatch sum).
- `headroom`: real Service Quotas limits returned, e.g.
  - On-demand tokens-per-minute (various models) = 100,000,000 TPM, used ≈ 569, 0%, status `ok`.
  - Max tokens-per-day = 144,000,000,000, status `ok`.

## Defect found & fixed during validation

The first response was dominated by per-day quotas (sorted purely by limit size), hiding the
per-minute (TPM) quotas that are usually the binding limit. Fixed `listTokenQuotas` to keep a
balanced top-N of both windows, and sorted the response by utilization first. Re-validated:
per-minute quotas now appear (8 shown).

## Verdict

All gates green; pipeline validated against real CloudWatch metrics and Service Quotas data.
Feature ready for review.
