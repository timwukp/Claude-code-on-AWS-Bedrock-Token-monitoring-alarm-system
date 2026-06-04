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
| 1 | **Enable Cost Anomaly Detection** | ⬜ | A setup script exists (`scripts/setup-cost-anomaly.sh`) but the monitor/subscription are not created by default. ML anomaly detection is the strongest observability addition — turn it on. |
| 2 | **Bedrock token-quota / throttle monitoring** | ⬜ | Bedrock enforces per-model **tokens-per-minute** and **max-tokens-per-day** quotas (HTTP 429 on breach). Surface `InvocationThrottles` and quota headroom in the dashboard so a pilot doesn't silently hit limits. See [`GOVERNANCE_FAQ.md`](./GOVERNANCE_FAQ.md) §2. |
| 3 | **Prompt-cache savings KPI** | 🟡 | Cache-read tokens are captured and priced at 0.1×, but the dashboard doesn't surface "$ saved by caching." Add a KPI — it's the strongest counter to "this is expensive." |

### Tier 2 — core controls (cost-cap credibility)

| # | Gap | Status | Notes |
|---|---|---|---|
| 4 | **Budget Action hard-stop enabled + validated** | 🟡 | A budget is deployed in notify-only mode (`enableAutoContainment: false`). The auto-apply-IAM/SCP hard stop is designed but not enabled or tested. Enable and validate a real spend-cap freeze (carefully — scope it so you don't lock yourself out). |
| 5 | **Per-project / per-user real-time enforcement** | ⬜ | Today the platform **observes and alerts** on per-project usage but cannot **instantly block** a single project at a $ threshold. Needs a per-tag budget action or a custom enforcement Lambda (EventBridge → scoped IAM deny). This is the largest capability gap for "what if one team runs away?" |

### Tier 3 — robustness & scale

| # | Gap | Status | Notes |
|---|---|---|---|
| 6 | **Enforce request-metadata tagging** | ⬜ | Per-project attribution depends on callers setting `requestMetadata` (`project_id`, `user_id`); there is guidance but no enforcement. Provide an SDK wrapper/middleware sample, or an IAM/condition-based control. See [`ATTRIBUTION.md`](./ATTRIBUTION.md). |
| 7 | **Per-project pre-aggregation** | ⬜ | The By-Project view runs Athena per request. Pre-aggregate per-project usage in the scheduled aggregator (write `TENANT#x#PROJECT` items) so it reads DynamoDB instead — faster and cheaper at scale. |
| 8 | **Fargate ETL path deploy + validate** | 🟡 | The heavy ETL stack (compaction to Parquet, reports) synthesizes but has not been deployed/validated; the ETL job logic is a `TODO` stub. |
| 9 | **Restrict CORS / custom domain / mapping-upload UX** | ⬜ | API CORS is permissive for demo; lock to the CloudFront origin. Add a custom domain (ACM) and a guided way to refresh the project-mapping CSV. |

## Notes

- Items here are reflected as `TODO` markers in the corresponding code where applicable.
- "Validated" claims are backed by [`VERIFICATION.md`](./VERIFICATION.md); this roadmap does not
  claim anything is done that has not actually run.
