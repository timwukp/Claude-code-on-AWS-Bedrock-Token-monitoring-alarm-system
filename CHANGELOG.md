# Changelog

All notable changes to this project are documented here. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/); this is reference/sample software, so entries
are grouped by development milestone rather than strict semver releases.

## [Unreleased]

### Added — Security hardening (ABAC + Permission Boundary)
- **ABAC system tag** — `cdk.Tags.of(app).add('system', 'token-monitor')` applied at App level
  in `infra/bin/infra.ts` so every synthesised resource inherits the isolation tag.
- **PermissionBoundaryAspect** (`infra/lib/aspects/permission-boundary.ts`) — CDK Aspect that
  walks all `iam.Role` nodes at synthesis time and stamps `TokenMonitorPermissionBoundary` on
  each one, including auto-generated Lambda service roles and Fargate task roles. Implements
  SEC05 (reduce blast radius) from the AWS Well-Architected Security pillar. The boundary policy
  (pre-created in AWS, referenced by ARN) denies `lambda:UpdateFunction*` and `iam:*RolePolicy`
  on resources tagged with a different `system` value — blocking cross-system contamination when
  multiple systems coexist in the same account.

### Added — Web UI completion
- **By-Project fast/full toggle** — the By-Project page now defaults to the DynamoDB pre-aggregated
  rollups (`?source=fast`) and offers a Full (Athena + project names) view; shows the data source.
- **Governance page** — new dashboard page + `GET /v1/governance` showing the Bedrock budget
  (limit / actual / forecast) and enforcement posture (Budget Action armed?, auto-containment
  mode). Read-only.

## Cost-governance feature set (issues #1–#9)

### Added
- **Cost Anomaly Detection as code (#1)** — `AWS::CE::AnomalyMonitor` (DIMENSIONAL/SERVICE) +
  `AWS::CE::AnomalySubscription` (IMMEDIATE→SNS, `ThresholdExpression`), replacing the manual script.
- **Bedrock token-quota / throttle monitoring (#2)** — `GET /v1/quotas` reports throttle status
  and per-model TPM / per-day quota headroom (Service Quotas); Usage page quota panel.
- **Prompt-cache savings KPI (#3)** — `/v1/costs` returns `cacheSavingsUsd`; Cost page shows how
  much prompt caching saves vs full input pricing (validated ~89% lower on real traffic).
- **Budget Action hard-stop + per-principal enforcement (#4, #5)** — opt-in, off-by-default
  `CfnBudgetsAction` (APPLY_IAM_POLICY) and a guarded containment path in the anomaly-response
  Lambda (refuses to act when disabled / allow-listed / unparseable — no self-lockout).
- **Request-metadata tagging helper (#6)** — `buildRequestMetadata` / `withRequestMetadata`
  (PII screening, Bedrock key/length limits) + `docs/INTEGRATION.md`.
- **Per-project pre-aggregation (#7)** — aggregator writes `TENANT#x#PROJECT` rollups;
  `GET /v1/projects?source=fast` reads DynamoDB instead of running Athena per request.
- **Fargate ETL job (#8)** — `etl.py` compacts raw NDJSON logs into partitioned Parquet (pure,
  offline-testable parser + stdlib unit tests).
- **CORS lockdown + custom domain + mapping-upload UX (#9)** — `api.allowedOrigins` config locks
  CORS to configured origins (default `*` for demo); optional ACM custom domain on CloudFront;
  `scripts/upload-project-mapping.sh`.

### Changed
- Fixed CI: the `infra` job installs backend deps so Lambda bundling (esbuild) works in a clean runner.
- Fixed a tenant-sanitizer bug that stripped `/` from IAM ARNs (forensic queries returned 0 rows).

### Testing
- Unit tests grew from 11 → 60+, plus per-feature English test reports under `docs/test-reports/`.
- Every feature validated end-to-end against a real AWS account (see `docs/VERIFICATION.md`).

## Initial release

### Added
- AWS-native, multi-tenant platform for monitoring Amazon Bedrock token usage: data pipeline
  (Model Invocation Logging → S3 → Glue/Athena), ingestion aggregator → DynamoDB, REST API behind
  Cognito, React/Vite dashboard (S3 + CloudFront), event-driven anomaly response.
- AWS CDK (TypeScript) infrastructure: Network / Data / Logging / Auth / Api / Automation / Etl /
  Frontend stacks.
- Documentation: architecture, Well-Architected review, monitoring approach, attribution,
  governance FAQ, roadmap, verification.
- CI: GitHub Actions + GitLab CI.
