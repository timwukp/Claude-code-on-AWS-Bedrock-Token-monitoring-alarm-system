# Test Report — Quota panel accuracy (per-model usage + clearer columns)

| | |
|---|---|
| Scope | Fixes to the Bedrock token-quota panel (#2 follow-up) |
| Branch | `fix/quota-panel-accuracy` |
| Date | 2026-06-09 |
| Environment | Real AWS account, `us-east-1` |
| Result | **PASS** — unit + real-AWS end-to-end |

## Problem (found via real-data review)

The quota panel had three issues:
1. **Misleading column** — the "Headroom" column actually showed *used %*, not remaining tokens.
2. **Noise** — it listed many models with no traffic (all 0%), crowding out the ones in use.
3. **(deeper bug, surfaced on real data)** **Used was account-wide total token usage compared
   against every model's quota** — e.g. the same `21181` total shown against Nemotron, Gemma,
   GLM, etc. That cross-model mis-attribution is meaningless.

## Fix

- **Per-model usage** — list ModelIds that have CloudWatch token metrics (real traffic), sum
  *each model's own* `InputTokenCount + OutputTokenCount` (by `ModelId` dimension), and match it
  to *that model's* per-minute / per-day Service Quotas limit via `matchQuotaForModel`
  (keyword match on the model name; skips when no quota matches — no mis-attribution).
- **Region-variant merge** — `us.`/`global.` variants of one model share a quota; their usage is
  merged so each (quota, window) appears once.
- **Clearer columns** — separate **Used %** and **Headroom (tokens left)**; per-model framing;
  a footnote explaining each column and its data source.
- **IAM** — added `cloudwatch:ListMetrics` to QuotasFn (needed to discover active models).

## Unit tests

`cd backend && npm test` → **68 passed** (added 6 in `quota-calc.test.ts`): `modelKeywords`
(strips region/provider/version/date), `matchQuotaForModel` (matches Opus 4.8 to its
minute/day quotas; refuses to mis-match a model with no quota).

## Build / synth gates

`tsc --noEmit`, frontend `npm run build`, `cdk synth env=ci` — all PASS.

## Real-AWS validation

Deployed `Tums-dev-Api`; `GET /v1/quotas` now returns one row per active model per window, each
matched to its own quota:

| Model (quota) | Window | Limit |
|---|---|---|
| Claude Sonnet 4.6 | minute / day | 6,000,000 / 8,640,000,000 |
| Claude Opus 4.7 | minute / day | 20,000,000 / 43,200,000,000 |
| Claude Opus 4.6 | minute / day | 3,000,000 / 4,320,000,000 |
| Claude Haiku 4.5 | minute / day | 5,000,000 / 7,200,000,000 |
| Amazon Nova Pro / Micro | minute / day | 1,000,000 / 4,000,000 … |

Used reads 0 when there's no traffic in the trailing window (correct); a model with live traffic
shows its own consumption against its own limit. Two IAM/permission issues found during
validation (`cloudwatch:ListMetrics` missing) were fixed and re-verified.

## Verdict

The panel now reflects reality: per-model usage vs per-model quota, clear Used % and Headroom
columns, no cross-model mis-attribution, no idle-model noise. Ready for review.
