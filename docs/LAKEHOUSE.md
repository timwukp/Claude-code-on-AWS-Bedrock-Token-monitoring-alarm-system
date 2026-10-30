# Lakehouse — bronze layer (P1)

The lakehouse replaces "query the table that sits on Bedrock's delivery prefix" with a governed medallion
pipeline: **bronze** keeps every source record verbatim, **silver** (P2) normalises them into one
vendor-neutral schema, **gold** (P3) aggregates for the dashboard and BI. This document describes what P1
builds. The programme plan is `~/.claude/plans/floating-enchanting-kahan.md` (owner copy) and the chain is
`intent/lakehouse-p1-bronze/`. Specs for every table live in `spec/lakehouse/*.schema.json` — the single
source of truth from which the CDK column lists and the Lambda row types are generated.

## Data flow (as built in P1)

```
Bedrock model-invocation logging ─(CloudWatch Logs destination, NEW)─► log group /tums/<env>/bedrock-invocations
   │                                                                      │ subscription filter
   │ >100 KB bodies ─(largeDataDeliveryS3Config)─► s3://tums-lakehouse-bodies-<env>-<acct>/   (not under any table)
   └(S3 destination, KEPT for the DynamoDB aggregator and the ETL)─► s3://<raw>/model-logs/…
                                                                          ▼
X-Ray Transaction Search (spans) ─► log group aws/spans ─subscription─► Firehose tums-lakehouse-<env>-bedrock
                                                                          │ Lambda transform (LakehouseTransformFn)
                                                                          │ routes each record via otfMetadata
                                                                          ├─► S3 Tables bronze.bedrock_invocations
                                                                          └─► S3 Tables bronze.otel_spans
CloudWatch Metric Streams (AWS/Bedrock, AWS/BedrockMantle, JSON) ─► Firehose tums-lakehouse-<env>-metrics
                                                                          └─► S3 Tables bronze.cw_metrics
AWS Data Exports (CUR 2.0, daily, resource-level, Parquet) ─► s3://tums-lakehouse-cur-<env>-<acct>/cur2/
                                                                          └─► Glue external table token_monitoring_<env>.cur_raw
Glue zero-ETL DynamoDB → S3 Tables (tums-dora, tums-tenants)   FLAGGED(`lakehouse.enableZeroEtl`, default off): Glue rejected the DynamoDB-source `IntegrationResourceProperty` on 2026-10-28; mirrors return when the resource shape is proven (P2 may use a Lambda export instead) — flip when the infra lands it

Failed Firehose records → s3://tums-lakehouse-errors-<env>-<acct>/errors/ (+ CloudWatch alarm)
```

Table bucket: `tums-lakehouse-<env>` (Amazon S3 Tables, Apache Iceberg). Namespaces `bronze`, `silver`, `gold`
are created in P1; only `bronze` has tables so far. S3 Tables runs compaction and snapshot maintenance itself,
so the streaming small files never need a compaction job of ours.

## Tables

All columns are lowercase snake_case (S3 Tables rejects capitals from Athena/Lake Formation). Every bronze
row carries `source`, `ingest_ts` and `raw` — the complete producer record as JSON text — so silver can be
rebuilt from bronze at any time without re-ingesting.

| Table | Storage | Partition | Key typed columns | `raw` holds |
|---|---|---|---|---|
| `bronze.bedrock_invocations` | S3 Tables | `event_day` | `event_ts`, `request_id`, `account_id`, `region`, `operation`, `model_id` (as logged — profile ARN or model id), `identity_arn`, `schema_version`, `input_body_s3_path` | the full Bedrock invocation-log record, inline request/response bodies ≤ 100 KB included (**PII**) |
| `bronze.cw_metrics` | S3 Tables | `metric_day` | `metric_ts`, `namespace`, `metric_name`, `dimensions` (JSON text), `unit`, `sum`, `count`, `min`, `max` | the Metric Streams datapoint |
| `bronze.otel_spans` | S3 Tables | `span_day` | `span_ts`, `trace_id`, `span_id`, `parent_span_id`, `name`, `service_name`, `kind`, `duration_ms`, `status_code`, `attributes` (JSON text; `gen_ai.*`, `aws.*`) | the span as exported by Transaction Search (**PII** possible in attributes) |
| `cur_raw` (Glue, `token_monitoring_<env>`) | external Parquet | `billing_period` (YYYY-MM, projected from the export path) | `bill_billing_period_start_date`, `line_item_usage_start_date`, `line_item_usage_end_date`, `line_item_line_item_type`, `product_servicecode`, `product_region_code`, `line_item_operation`, `line_item_usage_type`, `line_item_resource_id`, `line_item_usage_amount`, `line_item_unblended_cost`, `line_item_usage_account_id` | — (the export query selects exactly these columns) |

Retention: forever, by owner decision (2026-10-24). Bronze is never published to SMUS.

## Querying

Athena reaches the table bucket through the Glue federated catalog `s3tablescatalog/<bucket>`; the slash
makes the identifier non-plain, so quote it:

```sql
-- invocations landed today
SELECT model_id, count(*) AS calls
FROM "s3tablescatalog/tums-lakehouse-dev"."bronze"."bedrock_invocations"
WHERE event_day = date_format(current_date, '%Y-%m-%d')
GROUP BY 1 ORDER BY 2 DESC;

-- Mantle inferences per model (the metric read ListMetrics cannot see after two weeks)
SELECT json_extract_scalar(dimensions, '$.Model') AS model, sum(sum) AS inferences
FROM "s3tablescatalog/tums-lakehouse-dev"."bronze"."cw_metrics"
WHERE namespace = 'AWS/BedrockMantle' AND metric_name = 'Inferences' AND metric_day >= '2026-10-01'
GROUP BY 1;

-- GenAI spans
SELECT json_extract_scalar(attributes, '$["gen_ai.request.model"]') AS model, count(*)
FROM "s3tablescatalog/tums-lakehouse-dev"."bronze"."otel_spans"
WHERE span_day = date_format(current_date, '%Y-%m-%d') GROUP BY 1;

-- billing lines (ordinary Glue table)
SELECT line_item_usage_type, sum(line_item_unblended_cost) FROM token_monitoring_dev.cur_raw
WHERE billing_period = '2026-10' GROUP BY 1 ORDER BY 2 DESC;
```

Workgroup: `token-monitoring-<env>`. If Athena says "Insufficient permissions … Principal does not have any
privilege", the caller is missing Lake Formation grants on the catalog/namespace (see Governance).

## Governance

- **Lake Formation** owns access to the table bucket (registered as a data location with the
  `s3tablescatalog` federation). Grants: `LakehouseTransformFn` and the Firehose role — write on `bronze.*`;
  the **owner principal** (`lakehouse.ownerPrincipalArn` in config) — read on `bronze.*`; nothing else. The
  API Lambdas and the SMUS project role get silver/gold grants in P2/P3, never bronze.
- **PII**: `bronze.bedrock_invocations.raw` carries the inline request/response bodies (prompts and completions
  ≤ 100 KB) and `bronze.otel_spans.attributes` may carry prompt text. That is why bronze is locked down and
  why silver drops bodies.
- **Bodies > 100 KB** go to `tums-lakehouse-bodies-<env>-<acct>` (plain bucket, KMS, owner-readable only); the
  record keeps the pointer in `input_body_s3_path`. Nothing in the pipeline reads them.
- **SMUS**: the Glue catalog is registered as a DataZone data source in the configured domain/project
  (`lakehouse.smusDomainId` / `smusProjectId`) so silver/gold assets appear in the project catalog from P2;
  bronze is visible to the owner only.
- Encryption: S3 Tables SSE-KMS with the `DataStack` key where supported; buckets KMS; Firehose encrypts in flight.

## Silver (as built in P2)

**One canonical row per call, vendor-neutral.** `silver.invocations` uses the OpenTelemetry GenAI semantic conventions as
its vocabulary (`gen_ai.provider.name` → `vendor`, `gen_ai.request.model` → `model_key`, `gen_ai.usage.*` → token
columns, `gen_ai.operation.name` → `operation`/`api_family`, `gen_ai.response.finish_reasons` → `finish_reason`) plus AWS
extensions (`cache_read_tokens`, `cache_write_tokens`, `cache_write_ttl`, `aip_arn`, `route`, `reasoning_tokens`,
`tool_calls`). It carries **no request or response body** — only `body_s3_path`, the pointer bronze keeps.

**Three-layer value order, recorded per row in `token_source`.**
1. The Bedrock envelope (`input.inputTokenCount`, cache counts, `output.outputTokenCount`, `modelId`, `identity.arn`,
   `amazon-bedrock-invocationMetrics`) is authoritative for every vendor.
2. A vendor adapter (`backend/lambdas/lakehouse/adapters/`: `anthropic`, `openai` (Responses / Chat Completions),
   `converse`, `meta`, `mistral`, `cohere`, `ai21`, `titan-embeddings`, `generic`, `otel`) fills only what the envelope
   lacks — TTL split, finish reason, tool calls, reasoning tokens. When an adapter disagrees with the envelope the envelope
   wins and the pair is written to `silver.adapter_audit`.
3. The registry and `silver.dim_model` supply `project_id` / `attribution_source` and `vendor` / `family` / `price_status`;
   both are recomputed in SQL, so a registry change re-attributes history.

**Tables** (specs in `spec/lakehouse/silver.*.schema.json`): `invocations`, `dim_model` (every model the account can
call — foundation models, inference profiles, provisioned, custom, imported — with `price_status` ∈ priced /
unpriced_public / unpriced_private), `bill_daily` (CUR 2.0 folded to day × usage type × kind × route; the dollar truth),
`bedrock_metrics_hourly`, `project_registry` (hourly snapshot, `is_current`), `adapter_audit` (90-day retention).

**Attribution = rule C** (`docs/GOVERNANCE-ATTRIBUTION.md`): application inference profile ▷ registered identity (the
`tenant_key` is already the role or user — sessions are collapsed, so one hint covers every AgentCore session) ▷
`requestMetadata.project_id` ▷ `untagged`. `spec/lakehouse/sql/silver_20_attribution_merge.sql` recomputes it hourly
over the last two days and daily over 90.

**OTel rows merge, never double-count.** A span and a Bedrock record for the same `request_id` become one row
(`source='both'`): tokens from the envelope, `session_id` / `conversation_id` / `trace_id` / `service_name` from the
span. Spans with no Bedrock record stay as `source='otel'` — that is the only per-call view of bedrock-mantle and of
non-Bedrock providers behind a gateway.

**Schedule and gates.** `LakehouseSilverSfn` runs the files in `spec/lakehouse/sql/` in order every hour (the 90-day
attribution pass daily); five `quality_6x` statements must return zero rows or the run fails and alarms. The
`RegistrySnapshotFn` refreshes `silver.project_registry` hourly and `DimModelRefreshFn` rebuilds `silver.dim_model` daily.

**Dual-run check.** `cd scripts && npm install && ENV=dev npx ts-node verify-lakehouse.ts` recomputes attribution for a
sample of rows with the TypeScript rules and compares; it also reports tenant cardinality (target < 50) and the
`price_status` distribution.

## What gold adds (P3)

Daily cost by project×model, bill-vs-logged reconciliation (CUR × silver, Mantle included), latency by route, cache
churn per project, DORA×cost per repo, unattributed callers; materialised to DynamoDB for the Overview tiles; the Full
view and `/v1/queries` switch from the curated Parquet to silver/gold; QuickSight on gold.

## Runbooks

**One-time account bootstrap (before the first Lakehouse deploy).** CloudFormation grants Lake Formation
permissions as the CDK execution role, and Lake Formation only lets a *data lake administrator* grant on resources
it does not own. Add the role once, as an existing administrator, keeping every current admin:

```bash
aws lakeformation get-data-lake-settings --output json > /tmp/lf-before.json   # keep: this is the undo
python3 - <<'PY'
import json, subprocess
acct = subprocess.run(['aws','sts','get-caller-identity','--query','Account','--output','text'], capture_output=True, text=True).stdout.strip()
s = json.load(open('/tmp/lf-before.json'))['DataLakeSettings']
role = f'arn:aws:iam::{acct}:role/cdk-hnb659fds-cfn-exec-role-{acct}-us-east-1'
if not any(a['DataLakePrincipalIdentifier'] == role for a in s['DataLakeAdmins']):
    s['DataLakeAdmins'].append({'DataLakePrincipalIdentifier': role})
json.dump(s, open('/tmp/lf-after.json', 'w'))
PY
aws lakeformation put-data-lake-settings --data-lake-settings file:///tmp/lf-after.json
```

Without it the first deploy fails on `AWS::LakeFormation::PrincipalPermissions` with "Resource does not exist or
requester is not authorized" (dev, 2026-10-27, third attempt). Two more things learned on that day: a deleted S3
Tables bucket name stays "in a transitional state" for ~10–15 minutes, so a failed first create cannot be retried
immediately; and a failed first create leaves the RETAIN resources (three buckets, the Bedrock log group) behind —
delete them (they are empty) before retrying, or CloudFormation will report the names as already taken.

**Athena writes to S3 Tables need an SSE_S3 workgroup.** `INSERT`/`MERGE` into the federated catalog fail with
`INTERNAL_ERROR_QUERY_ENGINE` when the workgroup enforces SSE_KMS result encryption (controlled experiment, 2026-10-30:
same statement, SSE_S3 → SUCCEEDED, SSE_KMS → internal error; reads and no-op UPDATE/DELETE pass either way). The jobs
therefore run in `tums-lakehouse-<env>` (SSE_S3, enforced configuration so a job cannot redirect its output, 50 GiB
bytes-scanned cutoff per query); SSE_S3 is acceptable there because silver rows and the job results carry no request or
response bodies. Do not point them at the dashboard's KMS workgroup.

**First deploy order** (cross-stack references): `Tums-<env>-Automation` → `Data` → `Lakehouse` → `Logging`
(adds the CloudWatch destination; needs the log group and bodies bucket from Lakehouse) → `Etl` → `Api`.
Run `cdk diff` first; the owner authorises every deploy.

**Smoke test** (after deploy, from the repo root):

```bash
cd scripts && npm install && ENV=dev npx ts-node lakehouse-smoke.ts
```

It pushes seven synthetic invocation records of seven body shapes and one metric datapoint through the real
Firehose streams, waits for the Iceberg commit (≤ 5 min), and expects 7 / ≥1 rows and zero error objects.
Records carry `request_id LIKE 'smoke-%'` so they can be excluded or deleted.

**Re-driving a failed Firehose record**: failures land under
`s3://tums-lakehouse-errors-<env>-<acct>/errors/<stream>/processing-failed/…` (Lambda transform rejected it) or
`…/iceberg-failed/…` (table write rejected it) as newline-delimited JSON with `rawData` (base64) and
`errorMessage`. Fix the cause (usually a schema mismatch — the spec and the table must agree), then
base64-decode `rawData` and `aws firehose put-record` it back onto the same stream. The
`LakehouseFirehoseErrors` alarm fires when the errors prefix receives any object.

**Per-project attribution**: `./scripts/create-project-aip.sh <project> <model-id>...` creates tagged
application inference profiles and prints the `.claude/settings.json` snippet for that repo (Claude Code CLI
and Desktop both read it). Register the profiles in Settings → Project registry.

**Frontend publish**: `./scripts/deploy-frontend.sh <env>` now refuses to build when `frontend/.env.local`
is missing or names a Cognito pool other than the deployed one.

## Costs (estimate, dev volumes)

Records ≈ 1.5 GB/month, bodies ≈ 40 GB/month, metrics a few thousand updates/minute.

| Component | Basis | ≈ per month |
|---|---|---|
| Firehose (two streams) | per GB ingested + Iceberg delivery | < $1 |
| CloudWatch Logs (Bedrock destination, ingestion) | ~$0.50/GB | < $1 |
| Metric Streams | per metric update + Firehose | $1–5 |
| S3 Tables storage + maintenance + requests | 40 GB bodies in a plain bucket, ~2 GB tables | $2–5 |
| Data Exports (CUR 2.0) | free; S3 storage for Parquet | < $1 |
| Lambda transform | per invocation (batched by Firehose) | < $1 |
| Athena on bronze/silver | $5/TB; partitions prune to MBs | ≈ $0 |
| **Total** | | **≈ $10–30** (upper bound keeps headroom for Transaction Search indexing) |

The Fargate ETL and the Cost Explorer poller remain until P3 retires them.

## Known limits

- **bedrock-mantle is not logged by AWS** — invocation logging covers `bedrock-runtime` only. Mantle shows up in
  `bronze.cw_metrics` (inferences, tokens; no cache split) and in `cur_raw` (dollars), never as records.
- **Attribution needs a signal at call time** — an application inference profile per project (preferred),
  or a registered identity. The lakehouse cannot invent a project for a shared API key.
- **ListMetrics' two-week discovery window** hid Mantle models from the live metric read (qa F-PR77-002);
  `bronze.cw_metrics` keeps every datapoint, which supersedes that read in P2/P3.
- **Latency of the bronze path** is minutes (Firehose buffering); the DynamoDB rollups stay the 15-minute
  near-real-time source for the dashboard tiles until gold replaces them.
