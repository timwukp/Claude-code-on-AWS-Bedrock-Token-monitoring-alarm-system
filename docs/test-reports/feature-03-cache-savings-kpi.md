# Test Report — Feature #3: Prompt-cache savings KPI

| | |
|---|---|
| Issue | #3 |
| PR | #10 (merged) |
| Date | 2026-06-04 |
| Environment | Real AWS account, `us-east-1` |
| Result | **PASS** — unit tests + real-AWS end-to-end |

## Scope

Surface how much prompt caching saves versus charging cache-read tokens at the full input price.
Added a pure `cost-calc` module, `cacheSavingsUsd` to `GET /v1/costs`, and a "Saved by prompt
caching" KPI + per-model column on the Cost page.

## Unit tests

`cd backend && npm test` — `cost-calc.test.ts` (7 tests) PASS; 18 total PASS at the time.

Key cases:
- input+output+cache-read priced at the model rate;
- savings = cache-read at full input rate minus the 0.1× cache rate;
- unknown model → zero rate (cost shows 0, never wrong);
- totals across models.

## Build / synth gates

`tsc --noEmit`, frontend `npm run build`, and `cdk synth` all PASS. (CI also surfaced a
real bug — the infra job didn't install backend deps for Lambda bundling; fixed in the same PR.)

## Real-AWS end-to-end validation

Deployed `CostsFn`; called `GET /v1/costs` with a real JWT. Observed (real data):
- actual estimated spend ≈ **$16.70**
- **cache savings ≈ $131.63** (~89% lower than charging cache-read tokens at full input price),
  driven by ~29.25M cache-read tokens on Claude Opus.

## Verdict

All gates green; validated against real token aggregates. Merged as PR #10.
