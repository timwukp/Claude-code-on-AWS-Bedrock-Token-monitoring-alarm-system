# Test Reports

Per-feature test reports: unit tests, build/synth gates, and real-AWS end-to-end validation
results. One report per feature (mapped to a GitHub issue / PR).

| Feature | Issue | PR | Report | Result |
|---|---|---|---|---|
| Cost Anomaly Detection as code | #1 | #11 | [feature-01](./feature-01-cost-anomaly-detection.md) | PASS |
| Bedrock token-quota / throttle monitoring | #2 | — | [feature-02](./feature-02-token-quota-monitoring.md) | PASS |
| Prompt-cache savings KPI | #3 | #10 | [feature-03](./feature-03-cache-savings-kpi.md) | PASS |

Each report records: scope, unit-test results, build/synth gates, real-AWS validation evidence,
any defect found+fixed during validation, and a verdict. Reports are written before opening the
PR; a feature is only PR-ready when all gates are green.
