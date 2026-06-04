# Test Report — Feature #1: Cost Anomaly Detection as code

| | |
|---|---|
| Issue | #1 |
| PR | #11 (merged) |
| Date | 2026-06-04 |
| Environment | Real AWS account, `us-east-1` |
| Result | **PASS** — unit tests + real-AWS end-to-end |

## Scope

Create AWS Cost Anomaly Detection (ML) as infrastructure-as-code instead of a manual script:
`AWS::CE::AnomalyMonitor` (DIMENSIONAL/SERVICE) + `AWS::CE::AnomalySubscription` (IMMEDIATE→SNS,
`ThresholdExpression`), plus an SNS topic policy allowing `costalerts.amazonaws.com` to publish.

## Unit tests / gates

- `cd backend && npm test` — PASS (no new unit tests; this is infra-only).
- `cd infra && npx cdk synth --context env=ci` — PASS; template contains
  `AWS::CE::AnomalyMonitor` and `AWS::CE::AnomalySubscription`.

## Real-AWS end-to-end validation

Deployed `Tums-dev-Automation`. Verified via `aws ce get-anomaly-monitors` /
`get-anomaly-subscriptions`:
- Monitor `bedrock-spend-anomaly-dev` — type DIMENSIONAL, dimension SERVICE.
- Subscription `bedrock-anomaly-alerts-dev` — frequency IMMEDIATE, subscriber type SNS pointing
  at the alert topic, `ThresholdExpression` = ANOMALY_TOTAL_IMPACT_ABSOLUTE ≥ $10.

## Notes

- Confirmed no pre-existing monitors before deploy (no conflict/duplication).
- Cost Anomaly Detection evaluates real spend over time; alerts may begin within ~24h of monitor
  creation (per AWS docs). Creation + configuration are verified here; alert delivery is
  time-dependent on actual spend anomalies.

## Verdict

All gates green; monitor + subscription created and configured as expected. Merged as PR #11.
