# Test Reports

Per-feature test reports: unit tests, build/synth gates, and real-AWS end-to-end validation
results. One report per feature (mapped to a GitHub issue / PR).

| Feature | Issue | PR | Report | Result |
|---|---|---|---|---|
| Cost Anomaly Detection as code | #1 | #11 | [feature-01](./feature-01-cost-anomaly-detection.md) | PASS |
| Bedrock token-quota / throttle monitoring | #2 | #12 | [feature-02](./feature-02-token-quota-monitoring.md) | PASS |
| Prompt-cache savings KPI | #3 | #10 | [feature-03](./feature-03-cache-savings-kpi.md) | PASS |
| Budget Action hard-stop + per-principal enforcement | #4, #5 | #15 | [feature-04-05](./feature-04-05-controls.md) | PASS |
| Request-metadata tagging helper | #6 | #13 | [feature-06](./feature-06-enforce-tagging.md) | PASS |
| Per-project pre-aggregation (DynamoDB) | #7 | #16 | [feature-07](./feature-07-project-preaggregation.md) | PASS |
| Fargate ETL implementation | #8 | #14 | [feature-08](./feature-08-fargate-etl.md) | PASS |
| CORS lockdown + custom domain + mapping-upload UX | #9 | #17 | [feature-09](./feature-09-cors-domain.md) | PASS |
| Web UI completion (By-Project toggle + Governance page) | — | #18 | [feature-10](./feature-10-web-ui-completion.md) | PASS |

Each report records: scope, unit-test results, build/synth gates, real-AWS validation evidence,
any defect found+fixed during validation, and a verdict. Reports are written before opening the
PR; a feature is only PR-ready when all gates are green.

> Two items are 🟡 in [`../ROADMAP.md`](../ROADMAP.md) — the live Budget Action freeze (#4/#5) and
> the Fargate Parquet run (#8) — implemented and deploy-validated, with their live action
> deliberately deferred (risk-managed). These are planned roadmap items, not defects.
