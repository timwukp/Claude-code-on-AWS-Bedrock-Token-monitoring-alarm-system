# Architecture Validation

This document records that the system was deployed and exercised **end-to-end against a real AWS
account** (placeholder `123456789012`, `us-east-1`), driven by live Amazon Bedrock traffic
(Claude invocations via the Bedrock Runtime API). It captures the validated data flow, the
**log-schema findings that differ from the published AWS userguide example**, and a real bug the
live run surfaced. All account IDs, ARNs, and figures below are illustrative.

## Validated pipeline

```
Bedrock InvokeModel → Model Invocation Logging → S3 (KMS)
  → Glue table (OpenX JSON SerDe + partition projection) → Athena SQL → aggregates (DynamoDB)
  → API (Cognito-authed) → dashboard
```

Each stage was run for real, not just synthesized: logging delivered gzip'd NDJSON to S3; the
aggregator read and folded it into DynamoDB; the API returned it through a Cognito-authenticated
endpoint; the SPA rendered it.

## Log-schema findings (real data vs. userguide example)

Observed top-level keys in a delivered record:
`timestamp, accountId, region, requestId, operation, modelId, input, output, identity,
inferenceRegion, schemaType, schemaVersion`

| Field | Finding |
|---|---|
| `input.inputTokenCount` / `output.outputTokenCount` | Confirmed exactly as documented. |
| Records per file | Newline-delimited JSON (multiple records per file) → OpenX JSON SerDe is the correct reader. |
| **`identity.arn`** | **PRESENT** — holds the caller IAM ARN. The userguide's example schema omits it; real logs include it, enabling per-IAM-principal attribution directly. |
| `input.cacheReadInputTokenCount` / `cacheWriteInputTokenCount` | PRESENT — prompt-cache token accounting (cache-heavy workloads show large values here). |
| `input.inputBodyS3Path` | PRESENT — when the input body exceeds 100 KB it is stored as a separate `…/data/<requestId>_input.json.gz` object and referenced here. |
| `inferenceRegion` | PRESENT — set when using cross-region inference profiles. |
| `modelId` | Full ARN of the inference profile (e.g. `…/inference-profile/us.anthropic.claude-…`), not the short model id. |
| `requestMetadata` | Optional; present only when the caller supplies it (see `ATTRIBUTION.md`). |

## Confirmed S3 path layout

```
model-logs/AWSLogs/<account-id>/BedrockModelInvocationLogs/<region>/YYYY/MM/DD/HH/
  <timestamp>_<hash>.json.gz          # main records (metadata + token counts)
  data/<requestId>_input.json.gz      # split-out large bodies (>100 KB)
```

Athena **partition projection** is keyed on the `YYYY/MM/DD/HH` hierarchy under the region
prefix. Note projection's upper bound is "now" — files written under a future-dated partition
are not scanned until that time arrives.

## Aggregator behaviour verified on real data

The pure parsing/aggregation module (`backend/lambdas/ingestion/parse.ts`) has **no AWS calls**
and is unit-tested offline; the handler (`aggregator.ts`) wires it to S3 + DynamoDB. Verified:

- **Idempotency** — a watermark item records the last processed object time; re-runs skip
  already-seen objects, and aggregation de-dups by `requestId`.
- **Large-body / marker handling** — objects under `/data/` and `permission-check` markers are
  skipped; only main records carry token counts.
- **Unit tests** — `parse.test.ts` covers NDJSON parsing, malformed-line skipping, tenant
  derivation, hour bucketing, summation, and idempotency.

## API, auth, frontend, automation — all exercised live

- **Auth (Cognito)** — SRP sign-in yields a JWT; the API rejects unauthenticated calls with 401.
- **`GET /v1/usage`, `/v1/costs`, `/v1/anomalies`, `/v1/projects`** — all return tenant-scoped
  data; costs apply a per-MTok rate card including prompt-cache pricing.
- **`POST /v1/queries` + `GET /v1/queries/{id}`** — async Athena forensic queries return rows.
- **Frontend** — React/Vite SPA on S3 + CloudFront (OAC + WAF); CORS preflight from the
  CloudFront origin returns 204 allowing `Authorization`.
- **Automation** — the anomaly-response path was validated both by direct Lambda invocation and
  by the **real chain**: live Bedrock traffic → CloudTrail → EventBridge → Lambda → SNS. This
  confirms Bedrock `InvokeModel`/`Converse` reach EventBridge as **management events without a
  custom trail**.

## Bug found & fixed during live validation

`POST /v1/queries` initially returned **zero rows** for a tenant that clearly had data. Root
cause: the tenant-id sanitizer's allow-list omitted `/`, so an IAM-ARN tenant
(`arn:aws:iam::…:user/name`) was mangled to `…:username` and matched nothing. Fix: permit `/`
in the allow-list (still escaping quotes and dropping other unsafe characters) and add a
regression test (`backend/lambdas/api/queries.test.ts`). This is the kind of defect only a live,
real-data run surfaces — a useful argument for end-to-end validation over mocks alone.

## Note on sample/seed data

The "By Project" feature is illustrated with **seed data** — synthetic project-tagged records
plus a mapping CSV — because real attribution requires callers to set `requestMetadata`
(see `ATTRIBUTION.md`). The query, JOIN, and rollup logic are real; only the tagged input rows
are seeded. Likewise, a real `AccessDeniedException` is hard to provoke when most Bedrock models
are access-enabled, so that alert path can be exercised with a crafted event for demonstration.

## Reproduce

See `docs/DEPLOYMENT.md`. Minimal validation: deploy the Data stack, enable logging via
`aws bedrock put-model-invocation-logging-configuration`, generate Bedrock traffic, create the
Athena table from `docs/MONITORING_APPROACH.md`, then run the aggregator locally:

```bash
cd backend && npm install
AGGREGATES_TABLE=<your-aggregates-table> \
RAW_LOG_BUCKET=<your-raw-log-bucket> \
AWS_REGION=<your-region> \
npx ts-node scripts/run-aggregator-local.ts
```
