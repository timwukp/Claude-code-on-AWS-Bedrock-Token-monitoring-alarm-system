# Token Usage Monitoring System — Architecture Design

> A cross-industry, multi-tenant platform for monitoring **Amazon Bedrock** token usage,
> detecting cost anomalies, automating incident response, and providing deep analytics —
> deployable into any AWS account. Vendor-neutral; suitable for any customer.

---

## 1. Problem statement

Teams adopting Amazon Bedrock need to answer, continuously and per-tenant:

- **How many tokens / how much spend** are we generating, by model, team, and request tag?
- **Is today abnormal** compared to our learned baseline?
- **Can we respond automatically** to suspicious or denied access?
- **Can we prove it** — forensic, queryable, retained logs for audit & compliance?

Native CloudWatch alarms answer the first question with static thresholds only. This system
layers anomaly detection, automated response, and forensic analytics on top — using only
first-party AWS services plus Amazon Bedrock, so there is no third-party data egress.

The monitoring approach (metrics, Cost Anomaly Detection, EventBridge response, Model
Invocation Logging → Athena) is documented and source-verified in
[`MONITORING_APPROACH.md`](./MONITORING_APPROACH.md).

---

## 2. System overview

Three planes, one account (or one account per environment):

| Plane | Responsibility | Primary AWS services |
|---|---|---|
| **Front-end / Dashboard** | Operator UI: usage charts, anomaly feed, cost forecast, log search | S3, CloudFront, Cognito |
| **Back-end (API + automation)** | REST API, event-driven response, scheduled aggregation, heavy ETL | API Gateway, Lambda, EventBridge, Step Functions, Fargate, DynamoDB |
| **Data & analytics** | Raw log capture, queryable store, anomaly + budget signals | Bedrock Model Invocation Logging, S3, Athena/Glue, Cost Anomaly Detection, AWS Budgets |

### 2.1 High-level diagram

```
                          ┌──────────────────────────────────────────────────────┐
                          │                      End users                         │
                          │              (operators / FinOps / SecOps)             │
                          └───────────────────────────┬──────────────────────────┘
                                                       │ HTTPS
                                          ┌────────────▼────────────┐
                                          │        CloudFront        │  (TLS, WAF, OAC)
                                          │   + S3 (React/Vite SPA)  │
                                          └────────────┬────────────┘
                                                       │  JWT (Cognito)
                                          ┌────────────▼────────────┐
                                          │   API Gateway (REST)     │
                                          │   Cognito authorizer     │
                                          └────────────┬────────────┘
                                                       │
                              ┌────────────────────────┼────────────────────────┐
                              │                         │                        │
                     ┌────────▼────────┐      ┌─────────▼────────┐     ┌─────────▼─────────┐
                     │  API Lambdas    │      │  Athena query    │     │  Aggregates       │
                     │  (usage, costs, │◄────►│  (forensics,     │     │  (DynamoDB:       │
                     │   anomalies,    │      │   per-tenant SQL)│     │   pre-rolled KPIs)│
                     │   logs search)  │      └─────────┬────────┘     └─────────▲─────────┘
                     └─────────────────┘                │                        │
                                                         │                        │
   ╔═════════════════════════════════ DATA & AUTOMATION PLANE ════════════════════╪═══════╗
   ║                                                     │                        │       ║
   ║  ┌─────────────────┐   logs    ┌──────────────┐     │      ┌─────────────────┴────┐  ║
   ║  │ Amazon Bedrock  │──────────►│  S3 (raw      │─────┘      │ Scheduled aggregator │  ║
   ║  │ Model Invocation│           │  invocation   │            │ (EventBridge cron →  │  ║
   ║  │ Logging         │           │  logs, KMS)   │◄───────────│  Lambda / Step Fn)   │  ║
   ║  └─────────────────┘           └──────┬───────┘            └──────────────────────┘  ║
   ║                                        │ Glue catalog                                 ║
   ║  ┌─────────────────┐  CloudTrail  ┌────▼─────┐    ┌──────────────────────────────┐    ║
   ║  │ CloudTrail      │─────────────►│ EventBridge│──►│ Anomaly-response Lambda       │    ║
   ║  │ (InvokeModel    │   events     │  rules    │   │ (notify SNS, optional         │    ║
   ║  │  mgmt events)   │              └───────────┘   │  containment)                 │    ║
   ║  └─────────────────┘                              └───────────────┬──────────────┘    ║
   ║                                                                    │ SNS               ║
   ║  ┌──────────────────────┐   ┌─────────────────┐                   ▼                   ║
   ║  │ Cost Anomaly         │──►│ SNS topic       │──► email / chat / ticket             ║
   ║  │ Detection (ML)       │   └─────────────────┘                                      ║
   ║  ├──────────────────────┤                                                            ║
   ║  │ AWS Budgets          │──► forecast + actual alerts, optional Budget Action        ║
   ║  └──────────────────────┘                                                            ║
   ╚════════════════════════════════════════════════════════════════════════════════════╝

   Heavy/long-running ETL & report generation: ECS Fargate task (triggered by Step Functions),
   writes curated Parquet partitions back to S3 for cheaper Athena scans.
```

---

## 3. Component design

### 3.1 Front-end (React + Vite → S3 + CloudFront)

- **SPA** built with React + Vite + TypeScript, served as static assets from a **private S3
  bucket** fronted by **CloudFront** using **Origin Access Control (OAC)** — the bucket is not
  public.
- **Auth**: Amazon **Cognito User Pool** (hosted UI or embedded). The SPA holds a short-lived
  JWT and calls the API with it.
- **Dashboard views**:
  - *Usage* — input/output tokens & invocations over time, by model / tenant / request-metadata tag.
  - *Cost* — estimated spend (per-model rate card), Budgets actual vs forecast.
  - *Anomalies* — feed from Cost Anomaly Detection + custom signals, with severity & root cause.
  - *Logs* — ad-hoc forensic search backed by Athena (paged, async query pattern).
- **Charts**: client-side charting library (e.g. Recharts) over JSON from the API. QuickSight
  embedding is an optional alternative documented in the design but not the default.

### 3.2 API (API Gateway + Lambda)

REST API with a Cognito authorizer. Routes (illustrative):

| Method & path | Purpose | Backed by |
|---|---|---|
| `GET /v1/usage` | time-series token/invocation metrics | DynamoDB aggregates (fast) |
| `GET /v1/costs` | spend estimate + budget status | DynamoDB + Budgets API |
| `GET /v1/anomalies` | anomaly feed | DynamoDB (mirrored from SNS) |
| `POST /v1/queries` | start an Athena forensic query | Athena (async) |
| `GET /v1/queries/{id}` | poll query status/results | Athena |
| `GET /v1/tenants` | tenant list & config (admin) | DynamoDB |

**Multi-tenancy**: every request is scoped by a `tenantId` claim in the JWT. Aggregates and
Athena queries are filtered by tenant; tenant isolation is enforced in the API layer and in
IAM/Athena workgroup boundaries. See `docs/MULTI_TENANCY.md` (skeleton) for the model.

### 3.3 Event-driven automation (EventBridge + Lambda)

- **CloudTrail → EventBridge → anomaly-response Lambda.** `InvokeModel`,
  `InvokeModelWithResponseStream`, `Converse`, `ConverseStream` are CloudTrail **management
  events** (recorded by default), so no data-event selector is required for those. The Lambda
  branches on `errorCode` (e.g. `AccessDeniedException`) and off-hours heuristics, then notifies
  via SNS and optionally triggers containment.
- **Cost Anomaly Detection** publishes to an SNS topic (IMMEDIATE frequency → SNS subscriber).
- **AWS Budgets** raises actual + forecasted alerts; optionally a Budget Action applies a
  restrictive IAM policy as a hard stop.

### 3.4 Scheduled aggregation & heavy ETL (hybrid compute)

- **Lightweight, frequent**: an EventBridge **cron → Lambda** rolls raw counts into DynamoDB
  KPI aggregates so the dashboard reads are single-digit-ms and cheap (no Athena scan per page view).
- **Heavy, periodic**: a **Step Functions** workflow invokes an **ECS Fargate** task for
  large ETL (compact raw JSON logs into partitioned Parquet, generate compliance reports,
  rebuild Glue partitions). Fargate is used only for these long-running jobs — the API and
  event paths stay serverless. This is the "hybrid" model: Lambda for API/events, Fargate for
  batch.

### 3.5 Data plane (Bedrock logging → S3 → Athena)

- **Bedrock Model Invocation Logging** delivers newline-delimited JSON to a **KMS-encrypted S3
  bucket** (`input.inputTokenCount`, `output.outputTokenCount`, `modelId`, optional
  `requestMetadata` tags; **no IAM identity in the record** — tenant/developer attribution is
  via `requestMetadata` or CloudTrail correlation).
- **Glue Data Catalog** + **Athena** (OpenX JSON SerDe) make logs queryable. A curated Parquet
  layer (produced by the Fargate ETL) reduces scan cost.
- **Retention** is governed by S3 lifecycle + optional Object Lock per the customer's audit policy.

---

## 4. CDK stack decomposition

Infrastructure as code in **AWS CDK (TypeScript)**, split into independently deployable stacks
so blast radius is small and environments are reproducible:

| Stack | Contents |
|---|---|
| `NetworkStack` | VPC, subnets, endpoints (only what Fargate/ETL needs; serverless paths avoid VPC where possible) |
| `DataStack` | S3 (raw + curated, KMS), Glue database/tables, Athena workgroup, DynamoDB tables |
| `LoggingStack` | Bedrock model-invocation-logging config, CloudTrail trail, log-destination roles |
| `AuthStack` | Cognito user pool, app client, identity/JWT config |
| `ApiStack` | API Gateway, API Lambdas, authorizer, per-route IAM |
| `AutomationStack` | EventBridge rules, anomaly-response Lambda, SNS topics, Cost Anomaly Detection monitor/subscription, Budgets |
| `EtlStack` | Step Functions, ECS Fargate task definition, scheduled aggregator Lambda |
| `FrontendStack` | S3 site bucket, CloudFront + OAC, WAF, (optional) custom domain via ACM |

Config is environment-driven (`infra/lib/config`) so the same code deploys `dev` / `staging` /
`prod` with different account IDs, regions, and retention settings — no hard-coded customer names.

---

## 5. Key design decisions (and trade-offs)

| Decision | Choice | Why | Trade-off |
|---|---|---|---|
| IaC | CDK (TypeScript) | Type-safe, shares TS with frontend, rich L2 constructs, Well-Architected examples | AWS-specific (not multi-cloud) |
| Compute | Hybrid (Lambda + Fargate) | Scale-to-zero for API/events; Fargate only for long ETL | Two runtimes to operate |
| Frontend | React/Vite on S3+CloudFront | Cheapest, most portable, no SSR lock-in | Charts are client-rendered |
| Tenant attribution | `requestMetadata` tags | Bedrock logs carry no IAM identity | Requires callers to tag requests |
| Analytics store | S3 + Athena (+ Parquet) | Pay-per-scan, no cluster to run | Query latency vs a warm DB |
| Hot reads | DynamoDB pre-aggregates | Fast, cheap dashboard reads | Aggregation pipeline to maintain |

---

## 6. Security posture (summary)

- No public S3 buckets; CloudFront OAC only. WAF on CloudFront and API Gateway.
- KMS encryption at rest (S3, DynamoDB, logs); TLS in transit everywhere.
- Cognito-authenticated API; least-privilege IAM per Lambda; per-tenant scoping.
- CloudTrail + Model Invocation Logging for full auditability.
- Secrets via AWS Secrets Manager / SSM Parameter Store — never in code or env files.

Full control mapping is in [`WELL_ARCHITECTED.md`](./WELL_ARCHITECTED.md).

---

## 7. What is in this repository

```
Token_Usage_Monitoring_system/
├── docs/            architecture, Well-Architected review, monitoring approach, ADRs
├── infra/           AWS CDK app (TypeScript) — all stacks above
├── backend/         Lambda handlers (api, ingestion, anomaly-response, shared), Fargate ETL
├── frontend/        React + Vite SPA (dashboard)
├── .github/         CI/CD workflows (build, test, cdk deploy)
└── scripts/         bootstrap / deploy / teardown helpers
```

This delivery is the **design + a runnable repo skeleton**: each component has its structure,
interfaces, and a minimal working stub, with `TODO` markers where business logic is filled in.
See the root `README.md` for build & deploy steps.
