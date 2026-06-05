# Token Usage Monitoring System

A **cross-industry, multi-tenant** platform for monitoring **Amazon Bedrock** token usage,
detecting cost anomalies, automating incident response, and running forensic analytics —
deployable into **any AWS account**. Built AWS-native with the
[AWS Well-Architected Framework](https://docs.aws.amazon.com/wellarchitected/latest/framework/welcome.html).

> Vendor-neutral and customer-agnostic. No customer-specific names, accounts, or data are
> baked into the code — everything customer-specific is configuration.

---

## Why

Native CloudWatch alarms catch token spikes only with **static thresholds**. This system adds:

- **ML cost anomaly detection** (AWS Cost Anomaly Detection) — adapts to your baseline.
- **Automated response** (EventBridge + Lambda) — react, don't just alert.
- **Forensic analytics** (Bedrock Model Invocation Logging → S3 → Athena) — query everything.
- **Cost hard-stops** (AWS Budgets + Actions) and **rate safety nets** (Service Quotas).

The full, source-verified monitoring rationale is in
[`docs/MONITORING_APPROACH.md`](./docs/MONITORING_APPROACH.md).

---

## Architecture at a glance

```
React/Vite SPA ──► CloudFront+S3 ──► API Gateway (Cognito) ──► Lambda ──► DynamoDB (hot reads)
                                                              └────────► Athena (forensics)
Bedrock Model Invocation Logging ──► S3 (KMS) ──► Glue/Athena ──► Parquet (Fargate ETL)
CloudTrail ──► EventBridge ──► anomaly-response Lambda ──► SNS
Cost Anomaly Detection + AWS Budgets ──► SNS / Budget Actions
```

- **Full design:** [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md)
- **Well-Architected review (6 pillars):** [`docs/WELL_ARCHITECTED.md`](./docs/WELL_ARCHITECTED.md)

### Documentation

| Doc | What |
|---|---|
| [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) | System design, components, CDK stack decomposition |
| [`docs/WELL_ARCHITECTED.md`](./docs/WELL_ARCHITECTED.md) | Mapping to the six AWS Well-Architected pillars |
| [`docs/MONITORING_APPROACH.md`](./docs/MONITORING_APPROACH.md) | Source-verified monitoring mechanisms (metrics, logging, anomaly detection) |
| [`docs/GOVERNANCE_FAQ.md`](./docs/GOVERNANCE_FAQ.md) | Cost governance FAQ — observability, controls, operating practices |
| [`docs/ATTRIBUTION.md`](./docs/ATTRIBUTION.md) | Per-user / per-project usage attribution model |
| [`docs/INTEGRATION.md`](./docs/INTEGRATION.md) | Customer integration: request-metadata tagging helper |
| [`docs/MULTI_TENANCY.md`](./docs/MULTI_TENANCY.md) | Tenant isolation model |
| [`docs/VERIFICATION.md`](./docs/VERIFICATION.md) | Architecture validation + real-data schema findings |
| [`docs/ROADMAP.md`](./docs/ROADMAP.md) | Honest gap analysis — what's validated vs planned |
| [`docs/test-reports/`](./docs/test-reports/) | Per-feature test reports (unit + real-AWS validation) |
| [`CHANGELOG.md`](./CHANGELOG.md) | Notable changes by milestone |
| [`docs/DEPLOYMENT.md`](./docs/DEPLOYMENT.md) | Step-by-step deploy guide |
| [`AGENTS.md`](./AGENTS.md) | Guidance for AI coding agents working in this repo |

---

## Tech stack

| Layer | Technology |
|---|---|
| IaC | AWS CDK (TypeScript) |
| Compute | Hybrid — Lambda (API/events) + ECS Fargate (heavy ETL) |
| API | API Gateway (REST) + Cognito authorizer |
| Front-end | React + Vite + TypeScript |
| Hosting | S3 + CloudFront (Origin Access Control) |
| Data | S3 + Glue + Athena (+ Parquet), DynamoDB |
| Automation | EventBridge, Step Functions, SNS |
| Governance | Cost Anomaly Detection, AWS Budgets |

---

## Repository layout

```
.
├── docs/        Architecture, Well-Architected review, monitoring approach, ADRs, runbooks
├── infra/       AWS CDK app — Network/Data/Logging/Auth/Api/Automation/Etl/Frontend stacks
├── backend/     Lambda handlers + shared libs + Fargate ETL job
├── frontend/    React + Vite dashboard SPA
├── .github/     CI/CD workflows
└── scripts/     bootstrap / deploy / teardown helpers
```

---

## Prerequisites

- An AWS account + credentials (`aws configure`) with permission to deploy the stacks.
- Node.js 20+, npm, AWS CDK v2 (`npm i -g aws-cdk`), Docker (for Fargate image + Lambda bundling).
- Amazon Bedrock model access enabled in your target Region.

---

## Quick start

```bash
# 1. Install everything (infra + backend + frontend)
make install

# 2. Run the test + build + synth gates (no AWS account needed)
make test          # backend unit tests
make build         # backend type-check + frontend build
make synth ENV=ci  # cdk synth using the tracked placeholder config

# 3. Configure your own environment to deploy
cp infra/lib/config/example.env.json infra/lib/config/dev.json
$EDITOR infra/lib/config/dev.json     # set "account" and "region"

# 4. Bootstrap CDK once per account/region, then deploy
cd infra && npx cdk bootstrap && cd ..
make deploy ENV=dev

# 5. Build & publish the dashboard (prints the CloudFront URL)
make deploy-frontend ENV=dev
```

`make help` lists all targets. Full step-by-step (including teardown) is in
[`docs/DEPLOYMENT.md`](./docs/DEPLOYMENT.md). AI coding agents: see [`AGENTS.md`](./AGENTS.md).

---

## Status

Functionally complete and validated end-to-end against a real AWS account: data pipeline
(Bedrock logging → S3 → Athena), ingestion aggregator, REST API (usage / cost / anomalies /
projects / quotas / governance / forensic queries), Cognito auth, and a React dashboard with
**Usage, Cost, By-Project, Governance, and Anomalies** pages, plus event-driven anomaly response.

The full cost-governance feature set (issues #1–#9) is implemented and validated — ML cost
anomaly detection, token-quota/throttle monitoring, prompt-cache savings, opt-in Budget Action
hard-stop + per-principal enforcement, request-metadata tagging helper, per-project
pre-aggregation, Fargate ETL, and CORS/custom-domain hardening. See [`CHANGELOG.md`](./CHANGELOG.md),
[`docs/ROADMAP.md`](./docs/ROADMAP.md), and [`docs/VERIFICATION.md`](./docs/VERIFICATION.md).

Two items remain intentionally pending real-AWS exercise (off-by-default, risk-managed): the live
Budget Action **freeze** (needs a throwaway test IAM role) and the Fargate ETL **Parquet run**
(needs the Etl stack deployed). Both are marked 🟡 in the roadmap.

## Validation gates

CI (GitHub Actions and GitLab CI) runs, and any change must pass:

1. `cd backend && npm test` — Jest unit tests
2. `cd backend && npx tsc --noEmit` — type-check
3. `cd frontend && npm run build` — frontend build
4. `cd infra && npx cdk synth --context env=ci` — infrastructure synthesis

## License

MIT — see [`LICENSE`](./LICENSE). Suitable for public release.
