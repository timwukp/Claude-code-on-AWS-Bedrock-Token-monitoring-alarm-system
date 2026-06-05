# Roadmap

This document is an honest gap analysis: what the platform **has validated end-to-end today**
versus what is **designed but not yet built/enabled**. It exists so adopters can make informed
decisions and so the cost-governance story (see [`GOVERNANCE_FAQ.md`](./GOVERNANCE_FAQ.md)) is
backed by what actually runs, not just intent.

## Status legend

- ✅ **Done** — deployed and validated against a real AWS account (see [`VERIFICATION.md`](./VERIFICATION.md)).
- 🟡 **Partial** — implemented but not enabled/validated, or works but with a caveat.
- ⬜ **Planned** — designed, not yet built.

## What is validated today (✅)

- Data pipeline: Bedrock Model Invocation Logging → S3 (KMS) → Glue/Athena.
- Ingestion aggregator (idempotent, unit-tested) → DynamoDB.
- REST API (usage / cost / anomalies / projects / forensic queries) behind Cognito auth.
- React dashboard (Usage, Cost, By-Project, Anomalies).
- Event-driven response: CloudTrail → EventBridge → Lambda → SNS (real chain confirmed).
- Per-IAM-principal attribution via `identity.arn`; per-project attribution via request metadata
  joined to a mapping table.

## Gaps and planned work

Ordered by impact on a cost-governance rollout.

### Tier 1 — high value, low effort (do first)

| # | Gap | Status | Notes |
|---|---|---|---|
| 1 | **Enable Cost Anomaly Detection** | ✅ | Done — the monitor (`AWS::CE::AnomalyMonitor`, DIMENSIONAL/SERVICE) and an IMMEDIATE→SNS subscription (`AWS::CE::AnomalySubscription`, `ThresholdExpression`) are now created by `AutomationStack` and validated against the real account. The manual `scripts/setup-cost-anomaly.sh` remains for reference. |
| 2 | **Bedrock token-quota / throttle monitoring** | ✅ | Done — `GET /v1/quotas` reports throttle status (`InvocationThrottles`/client errors, with no-datapoints treated as 0) and per-model TPM/per-day quota headroom from Service Quotas; the Usage page shows a quota panel. Validated against real CloudWatch + Service Quotas data. See [`test-reports/feature-02`](./test-reports/feature-02-token-quota-monitoring.md). |
| 3 | **Prompt-cache savings KPI** | 🟡 | Cache-read tokens are captured and priced at 0.1×, but the dashboard doesn't surface "$ saved by caching." Add a KPI — it's the strongest counter to "this is expensive." |

### Tier 2 — core controls (cost-cap credibility)

| # | Gap | Status | Notes |
|---|---|---|---|
| 4 | **Budget Action hard-stop enabled + validated** | 🟡 | Implemented as an opt-in `CfnBudgetsAction` (APPLY_IAM_POLICY) that attaches a deny-Bedrock policy at a configured % of budget; off by default. Synth verified (on/off paths) and deployed with enforcement off. **Live freeze deliberately not triggered** (would require a throwaway test IAM role) — see [`test-reports/feature-04-05`](./test-reports/feature-04-05-controls.md). |
| 5 | **Per-project / per-user real-time enforcement** | 🟡 | The anomaly-response Lambda can now attach the deny policy to an offending IAM principal on AccessDenied — guarded by a pure decision (disabled / allow-listed / unparseable → no-op, preventing self-lockout) and unit-tested. Off by default; deploy-validated (correctly skips when disabled). Live containment of a real principal pending an isolated test role. See [`test-reports/feature-04-05`](./test-reports/feature-04-05-controls.md). |

### Tier 3 — robustness & scale

| # | Gap | Status | Notes |
|---|---|---|---|
| 6 | **Enforce request-metadata tagging** | ⬜ | Per-project attribution depends on callers setting `requestMetadata` (`project_id`, `user_id`); there is guidance but no enforcement. Provide an SDK wrapper/middleware sample, or an IAM/condition-based control. See [`ATTRIBUTION.md`](./ATTRIBUTION.md). |
| 7 | **Per-project pre-aggregation** | ✅ | Done — the aggregator writes `TENANT#<tenant>#PROJECT` rollups (per project+model, with a distinct-user set); `GET /v1/projects?source=fast` reads them from DynamoDB instead of running Athena. Validated against real data. See [`test-reports/feature-07`](./test-reports/feature-07-project-preaggregation.md). |
| 8 | **Fargate ETL path deploy + validate** | 🟡 | ETL job logic implemented in `backend/analysis/etl.py` (S3 list/gunzip/parse → flatten verified schema → partitioned Parquet to `usage/dt=YYYY-MM-DD/`), with a pure offline-testable `parse_log_lines` and stdlib unit tests (`test_etl.py`, 8 passing). Implemented, pending real-AWS deploy/validation of the Fargate stack against a live bucket. |
| 9 | **Restrict CORS / custom domain / mapping-upload UX** | ⬜ | API CORS is permissive for demo; lock to the CloudFront origin. Add a custom domain (ACM) and a guided way to refresh the project-mapping CSV. |

## Notes

- Items here are reflected as `TODO` markers in the corresponding code where applicable.
- "Validated" claims are backed by [`VERIFICATION.md`](./VERIFICATION.md); this roadmap does not
  claim anything is done that has not actually run.
