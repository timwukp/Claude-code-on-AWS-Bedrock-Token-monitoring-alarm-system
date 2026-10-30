# Intent: one vendor-neutral row per call, and attribution that can be recomputed

- **Slug:** lakehouse-p2-silver
- **Author:** Claude (AI agent)
- **Date:** 2026-10-30
- **Accepted-by:** Tim WU
- **Status:** accepted

## Problem

P2 of the lakehouse programme (plan `floating-enchanting-kahan`, approved 2026-10-24; R2, R5, R6, R8, R11, R12). Bronze
(P1, #79) keeps every Bedrock record, metric datapoint and OTel span verbatim, but nothing downstream can use it yet:

1. **Every vendor logs a different body.** Anthropic `messages`, Converse, OpenAI Responses (`input` array or string),
   Chat Completions, Titan embeddings, image/video models — the dashboard today prices only what the Bedrock envelope
   states and cannot read TTL splits, reasoning tokens, tool calls or finish reasons without vendor code in every reader.
2. **Attribution is frozen at ingest.** The DynamoDB rollups attribute a call once; registering a role or profile later
   (F-004: `llmops-agentic-system`, the owner's shared Claude Desktop keys) cannot re-attribute history.
3. **2,524 tenants.** Every AgentCore session ARN became its own tenant; per-tenant views are unusable.
4. **Two sources for one call.** OTel spans (via Transaction Search) and Bedrock records describe the same request; nothing
   joins them, so session/conversation ids and gateway latency are invisible and Mantle calls (never logged) are unseen.
5. Dollars still come from a daily Cost Explorer API call, not from the CUR export that P1 switched on.
6. Two P1 leftovers: `AWS::Bedrock::ModelInvocationLoggingConfiguration` is not a CloudFormation type (the Logging stack
   never deployed), and the Bedrock-logs role ARN carried a stray `:*`.

## Desired outcome

- `silver.invocations`: one row per call, vocabulary = OpenTelemetry GenAI semantic conventions + AWS extensions, no bodies;
  the Bedrock envelope is authoritative, vendor adapters fill the gaps and disagreements are audited.
- Rule C attribution (AIP ▷ identity ▷ metadata ▷ untagged) recomputed hourly / daily by SQL from an hourly registry
  snapshot; `tenant_key` collapsed to the role or user; OTel and Bedrock rows merged on `request_id`.
- `silver.dim_model`, `silver.bill_daily` (CUR), `silver.bedrock_metrics_hourly`, `silver.project_registry`,
  `silver.adapter_audit`; five quality gates that fail the run and alarm.
- Logging configured by a CDK custom resource; role ARN fixed; `scripts/verify-lakehouse.ts` proves TS/SQL agreement.

## Out of scope

Gold tables, the Full-view / `/v1/queries` switch to silver, QuickSight, the dashboard's unattributed-callers panel (P3);
Glue zero-ETL mirrors (flagged off since #82); the workspace-hint attribution tier (needs owner consent — it reads prompts).
