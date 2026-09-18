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

![Architecture diagram](./diagrams/architecture.png)

*(Generated with the AWS Diagram MCP server and verified against the deployed CDK stacks. For the
end-to-end request and background data flows, see "How the data flows" in the
[README](../README.md#architecture-at-a-glance).)*

What this architecture buys you:

- **Predictable, low cost.** The real-time paths (API and ingestion) are serverless and
  scale to zero — when no one is using it, you pay almost nothing; only the heavy batch ETL runs
  inside a VPC. You don't carry a standing bill just to *be able to* monitor.
- **Multi-tenant security built in.** After a user signs in, API Gateway verifies identity
  before a request reaches any logic, and data is isolated per tenant — one deployment safely
  serves many teams, none able to see another's usage.
- **Instant dashboards, forensics on demand.** Everyday usage is a millisecond-fast DynamoDB hot
  read; deeper investigation ("who / which project / when") runs on Athena only when you ask. The
  common case stays fast and cheap, and heavy queries don't slow it down.
- **Cost protection that doesn't need a babysitter.** Spend anomalies and suspicious access
  raise alerts on their own, whether or not anyone is signed in. The enforcing actions that
  *freeze* access (the Budgets Action hard-stop and per-principal containment) are **off by
  default** — so you can observe and validate the rules first, then opt in to hard enforcement
  without risking a self-inflicted lockout on day one.
---

## 3. Component design

### 3.1 Front-end (React + Vite → S3 + CloudFront)

- **SPA** built with React + Vite + TypeScript, served as static assets from a **private S3
  bucket** fronted by **CloudFront** using **Origin Access Control (OAC)** — the bucket is not
  public.
- **Auth**: Amazon **Cognito User Pool** (hosted UI or embedded). The SPA holds a short-lived
  JWT and calls the API with it.
- **Dashboard views**:
  - *Usage* — input/output tokens & invocations over time, plus a Bedrock token-quota / throttle panel.
  - *Cost* — estimated spend (per-model rate card) with a prompt-cache savings KPI.
  - *By Project* — per-project/user attribution with a Fast (DynamoDB) / Full (Athena + names) toggle.
  - *Governance* — Bedrock budget (limit / actual / forecast) and enforcement posture (Budget
    Action hard-stop, auto-containment mode).
  - *Anomalies* — feed from Cost Anomaly Detection + automated response, with severity & root cause.
  - *DORA* — the four delivery metrics per repo, split All / AI-assisted / Human-only, plus
    Delivery × Cost rows per project.
  - *ROI* — break-even engineer-hours first, then per-project component waterfalls, a portfolio
    quadrant, unit economics, and a reference-class budget estimator. Every assumption is shown
    with its source, and the terms the model refuses to compute are listed rather than zero-filled.
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
| `GET /v1/dora/repos` · `POST /v1/dora/repos` (admin) | tracked-repo registry for DORA metrics | DynamoDB `tums-dora` |
| `DELETE /v1/dora/repos/{owner}/{name}` · `POST …/sync` (admin) | remove a repo / trigger a collector run | DynamoDB + async Lambda invoke |
| `GET /v1/dora/metrics?repo=&window=` · `GET /v1/dora/overview` | 4 DORA metrics (All / AI-assisted / Human) + weekly timeline; per-repo comparison | computed on read from `tums-dora` |
| `GET /v1/dora/projects?window=` | Delivery × Cost per project: pooled DORA + windowed token cost, $/deployment | `tums-dora` + `PROJDAY` rollups + registry |
| `GET·POST /v1/projects/registry` · `DELETE …/{id}` (admin) | project registry: name / cost center / repos / identity hints | DynamoDB `tums-tenants` |
| `GET /v1/projects/registry/defaults` · `PUT …` (admin) | org-wide ROI assumption defaults | `REGISTRY#META` item in `tums-tenants` |
| `GET /v1/roi/projects?window=30\|90` | per-project ROI: component breakdown, break-even, unit economics, reference bands, kill-fast signal, refusals | `PROJDAY` rollups + `tums-dora` + registry assumptions |
| `GET /v1/roi/estimate?reference=&prsPerMonth=` | reference-class budget band + projected break-even for a new project | 90-day history of the chosen reference project |
| `GET /v1/latency?window=1\|7\|30` | model-hop latency: p50/p95/p99 end-to-end + time to first token, fleet and per model, plus the hop-observability model | CloudWatch `AWS/Bedrock` (`InvocationLatency`, `TimeToFirstToken`) |

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

- **DORA collector** (`DoraStack`): an EventBridge **rate(6h) → Lambda** pulls merged PRs (with
  their commits, for first-commit time and `Co-Authored-By` AI trailers) and bug/incident issues
  from the GitHub REST API for each admin-registered repo into the `tums-dora` table, incrementally
  via per-repo watermarks. It reads a fine-grained PAT from Secrets Manager and stops early when
  the GitHub rate limit runs low (resuming next run). Metrics are computed on read by the API.

- **Project attribution (#13)**: the aggregator resolves application-inference-profile ARNs
  seen in logs (GetInferenceProfile + `tums-project` tag, cached in the registry), attributes each
  record (profile tag → requestMetadata → identity hint → untagged), re-keys profile traffic to
  the real underlying model, and writes `PROJDAY` daily per-project rollups alongside the
  existing hourly/model/project ones.

- **Runaway-spend guard (#14)**: in the same aggregator pass, any single request whose estimated
  cost exceeds `RUNAWAY_REQUEST_USD` (default 50, `0` disables) is written to the anomalies table
  with a deterministic sort key derived from the request id, so re-puts are idempotent and the
  item renders on the existing Anomalies page. Judging "justified long task versus runaway loop"
  stays a human call; the guard only makes the request visible within one rollup cycle.

### 3.5 Data plane (Bedrock logging → S3 → Athena)

- **Bedrock Model Invocation Logging** delivers newline-delimited JSON to a **KMS-encrypted S3
  bucket** (`input.inputTokenCount`, `output.outputTokenCount`, `modelId`, optional
  `requestMetadata` tags; **no IAM identity in the record** — tenant/developer attribution is
  via `requestMetadata` or CloudTrail correlation).
- **Glue Data Catalog** + **Athena** (OpenX JSON SerDe) make logs queryable. A curated Parquet
  layer (produced by the Fargate ETL) reduces scan cost.
- **Retention** is governed by S3 lifecycle + optional Object Lock per the customer's audit policy.

### 3.6 Latency read (CloudWatch metrics, no data plane of its own)

`GET /v1/latency` is the only read path in the system that touches **no** table. It queries
CloudWatch `GetMetricData` against the `AWS/Bedrock` namespace for `InvocationLatency` (the whole
model call) and `TimeToFirstToken` (the streaming prefix), asking CloudWatch for `p50`/`p95`/`p99`
and `SampleCount` directly rather than computing percentiles from datapoints we fetched. `ListMetrics`
enumerates the `ModelId` dimension for the per-model table, capped at 12 series.

Three design consequences worth stating, because each is a limit rather than a feature:

- **No tenant dimension exists on these metrics**, so `LatencyFn`'s IAM is `cloudwatch:GetMetricData`
  + `cloudwatch:ListMetrics` on `*` and nothing else, and the endpoint is honest that it reports an
  account-level fleet view. Per-project latency is a different source entirely — the invocation logs
  — and is not built.
- **CloudWatch computes each percentile inside its own period bucket.** Asking for a period equal to
  the whole window does not guarantee one bucket back. Where several come back, the response
  collapses them to a sample-count-weighted mean and flags the value `approximated`; an unflagged
  percentile is exact for the window. In practice a 7-day window returns one bucket and a 30-day
  window does not.
- **The observability of each hop is data, not page copy.** `hopModel()` in
  `backend/lambdas/api/latency.ts` is the single definition of the five-hop chain (IDE/CLI → gateway
  → Bedrock TTFB → Bedrock streaming → Guardrails) and of which two hops are measurable. The page
  renders that array, so the claim lives with the data that backs it; a hop marked `unmeasured` is
  structurally forbidden from carrying a metric, and the unit tests assert it. The generation segment
  is `e2e − ttft` per percentile and is flagged `derived`, because percentile arithmetic is not valid
  arithmetic and the label is the only thing keeping the number from being a fabrication.

---

## 4. CDK stack decomposition

Infrastructure as code in **AWS CDK (TypeScript)**, split into independently deployable stacks
so blast radius is small and environments are reproducible:

| Stack | Contents |
|---|---|
| `NetworkStack` | VPC, subnets, endpoints (only what Fargate/ETL needs; serverless paths avoid VPC where possible) |
| `DataStack` | S3 (raw + curated, KMS), Glue database/tables, Athena workgroup, DynamoDB tables |
| `LoggingStack` | Bedrock model-invocation-logging config, CloudTrail trail, log-destination roles |
| `AuthStack` | Cognito user pool, app client, identity/JWT config, `admin` group |
| `ApiStack` | API Gateway, API Lambdas, authorizer, per-route IAM |
| `AutomationStack` | EventBridge rules, anomaly-response Lambda, SNS topics, Cost Anomaly Detection monitor/subscription, Budgets |
| `EtlStack` | Step Functions, ECS Fargate task definition, scheduled aggregator Lambda |
| `DoraStack` | GitHub-token secret (Secrets Manager), scheduled DORA collector Lambda; no VPC/Docker so it deploys independently of `EtlStack` |
| `ProjectsStack` | Tagged application inference profiles per project×model (cost attribution); opt-in "profiles-only" managed policy + pilot test role |
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
| ROI framing | Refuse rather than estimate | A number a skeptic can dismantle is worse than an absent one; break-even needs only spend and an hourly rate | Several projects show no ROI headline until their own staffing is configured |

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
