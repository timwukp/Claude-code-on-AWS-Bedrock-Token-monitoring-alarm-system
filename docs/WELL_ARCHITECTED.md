# Well-Architected Review — Token Usage Monitoring System

This document maps the system to the **six pillars** of the AWS Well-Architected Framework.
Each pillar lists the design decisions, the relevant AWS service behaviour, and the
trade-offs accepted. It is intended to be read alongside [`ARCHITECTURE.md`](./ARCHITECTURE.md).

> Framework reference: AWS Well-Architected Framework —
> https://docs.aws.amazon.com/wellarchitected/latest/framework/welcome.html
> Per-pillar references are linked in each section.

---

## 1. Operational Excellence

> https://docs.aws.amazon.com/wellarchitected/latest/operational-excellence-pillar/welcome.html

**Design decisions**

- **Everything is code.** All infrastructure is AWS CDK (TypeScript); no console click-ops.
  Stacks are independently deployable (`DataStack`, `ApiStack`, …) for small blast radius.
- **CI/CD.** GitHub Actions builds, tests, synthesizes (`cdk synth`), and deploys per
  environment. Pull requests run lint + unit tests + `cdk diff`.
- **Observability of the monitor itself.** The platform's own Lambdas emit structured logs,
  metrics, and traces (AWS X-Ray). Dashboards and alarms watch the watcher (e.g. ingestion
  lag, Athena query failures, DLQ depth).
- **Runbooks.** `docs/runbooks/` (skeleton) holds operational procedures: anomaly triage,
  failed-ETL replay, key rotation.

**Trade-offs**: two runtimes (Lambda + Fargate) increase operational surface; mitigated by
keeping Fargate to a single, well-bounded ETL task.

---

## 2. Security

> https://docs.aws.amazon.com/wellarchitected/latest/security-pillar/welcome.html

**Identity & access**
- Amazon **Cognito** authenticates dashboard users; API Gateway uses a Cognito JWT authorizer.
- **Least-privilege IAM** per Lambda (scoped to the exact tables/buckets/queries it needs).
- **Multi-tenant isolation** enforced by `tenantId` JWT claim + Athena workgroup / S3 prefix
  scoping; no cross-tenant data access path.
- **ABAC isolation (SEC05 — reduce blast radius)**: every resource in this app is tagged
  `system=token-monitor` via `cdk.Tags.of(app).add('system', 'token-monitor')` in `bin/infra.ts`.
  All IAM execution roles carry a **Permission Boundary** (`TokenMonitorPermissionBoundary`)
  applied by a CDK Aspect at synthesis time. The boundary denies `lambda:UpdateFunction*` and
  `iam:*RolePolicy` on any resource whose `system` tag differs — preventing cross-system
  contamination even when sibling systems share the same AWS account. The Aspect covers
  auto-generated roles (Lambda service roles, Fargate task roles) automatically.

**Detective controls**
- **AWS CloudTrail** records Bedrock `InvokeModel` / `Converse` as management events (on by
  default) — the source of the security event stream.
- **Bedrock Model Invocation Logging** provides full request/response forensics.
- **Amazon GuardDuty** (recommended enablement) analyses CloudTrail for suspicious Bedrock API
  behaviour.

**Data protection**
- **No public S3 buckets.** Static site served only via CloudFront **Origin Access Control**.
- **KMS** customer-managed keys for S3, DynamoDB, and logs; **TLS** enforced in transit.
- **AWS WAF** on CloudFront and API Gateway; secrets in **Secrets Manager / SSM**, never in code.

**Automated response**
- EventBridge → anomaly-response Lambda can notify and (optionally) apply containment such as
  a restrictive IAM policy via an **AWS Budgets Action** hard-stop.

**Trade-offs**: optional auto-containment is powerful but risky; it ships **disabled by
default** (notify-only) and is opt-in per tenant.

---

## 3. Reliability

> https://docs.aws.amazon.com/wellarchitected/latest/reliability-pillar/welcome.html

**Design decisions**
- **Managed, multi-AZ services** by default: S3, DynamoDB, Lambda, API Gateway, Athena are all
  regionally resilient. Fargate ETL runs across multiple AZs in the VPC.
- **Decoupling & buffering.** Event paths use EventBridge + SNS; failures route to **dead-letter
  queues** with retry. The dashboard reads pre-aggregated DynamoDB so a slow Athena query never
  breaks the UI.
- **Idempotent ingestion.** Aggregation keys on `requestId` so replays don't double-count.
- **Backups & retention.** DynamoDB point-in-time recovery; S3 versioning + lifecycle; logs
  retained per the customer's audit policy (optionally with Object Lock).

**Trade-offs**: Athena query latency is variable; accepted because forensic queries are
interactive/async, not on the hot path.

---

## 4. Performance Efficiency

> https://docs.aws.amazon.com/wellarchitected/latest/performance-efficiency-pillar/welcome.html

**Design decisions**
- **Right-sized compute per workload.** Lambda for spiky API/event work (scale-to-zero);
  Fargate only for sustained ETL — avoids paying for idle servers.
- **Read/write separation.** Hot dashboard reads hit DynamoDB pre-aggregates; cold/forensic
  reads hit Athena. Each is sized for its access pattern.
- **Cheaper scans.** A curated **Parquet** layer + partitioning reduces Athena data scanned
  (and therefore cost and latency) versus raw JSON.
- **Edge delivery.** CloudFront caches the SPA globally close to users.

**Trade-offs**: maintaining a second (Parquet) copy of data costs storage; justified by lower
repeated-scan cost at volume.

---

## 5. Cost Optimization

> https://docs.aws.amazon.com/wellarchitected/latest/cost-optimization-pillar/welcome.html

**Design decisions**
- **Serverless-first / scale-to-zero.** No always-on servers on the API or event paths.
- **Pay-per-use analytics.** Athena charges per TB scanned ($5/TB at time of writing);
  partitioning + Parquet + the DynamoDB hot path keep scans minimal.
- **Native cost governance built in.** **AWS Budgets** (monitoring free; Budget Actions free
  for first 2, then $0.10/day) and **Cost Anomaly Detection** (ML, free feature) are part of
  the product, not just monitored by it.
- **Tagging & showback.** `requestMetadata` tags + cost allocation tags enable per-tenant /
  per-team showback.
- **Lifecycle.** S3 lifecycle transitions old raw logs to cheaper storage classes.

**Trade-offs**: prices/quotas vary by Region and change over time — figures must be reconfirmed
against the live AWS pricing pages before budgeting (see Sources in `MONITORING_APPROACH.md`).

---

## 6. Sustainability

> https://docs.aws.amazon.com/wellarchitected/latest/sustainability-pillar/welcome.html

**Design decisions**
- **Scale-to-zero serverless** means no idle compute consuming energy.
- **Efficient data formats** (Parquet, compression, partition pruning) reduce bytes scanned
  and stored.
- **Lifecycle expiry** removes data that no longer serves a business/audit purpose.
- **Managed services** ride AWS's shared, high-utilization infrastructure rather than
  dedicated under-utilized hardware.

---

## 7. Pillar summary

| Pillar | Headline mechanism | Status in skeleton |
|---|---|---|
| Operational Excellence | 100% IaC + CI/CD + self-observability | scaffolded |
| Security | Cognito + least-privilege + KMS + no public buckets + auto-response | scaffolded |
| Reliability | Managed multi-AZ + DLQs + idempotency + PITR | scaffolded |
| Performance | Lambda/Fargate split + DynamoDB hot path + Parquet | scaffolded |
| Cost | Serverless + Athena pay-per-scan + Budgets/Anomaly Detection | scaffolded |
| Sustainability | Scale-to-zero + efficient formats + lifecycle | scaffolded |

> "Scaffolded" = the structure, IAM intent, and config hooks exist in the repo; business logic
> and tuning are filled in per deployment. Each `TODO` in code points back to the relevant
> pillar decision here.
