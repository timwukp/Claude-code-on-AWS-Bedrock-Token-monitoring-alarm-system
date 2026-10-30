# Spec: lakehouse silver

- **Intent:** ./intent.md
- **Author:** Claude (AI agent)
- **Accepted-by:** Tim WU
- **Status:** shipped

## 1. Spec (single source of truth)
`spec/lakehouse/silver.{invocations,dim_model,bill_daily,bedrock_metrics_hourly,project_registry,adapter_audit}.schema.json`;
`backend/scripts/gen-lakehouse-ddl.ts` regenerates `spec/lakehouse/generated/tables.json` and
`backend/lambdas/lakehouse/generated/row-types.ts`; `generated.test.ts` fails on drift. `silver.invocations` carries no
body column (only `body_s3_path`); `adapter_audit` retention 90 days; the rest forever.

## 2. Canonical row and adapters (`backend/lambdas/lakehouse/canonical.ts`, `adapters/*.ts`)
- Value order per field: Bedrock envelope ▷ vendor adapter ▷ registry/dim_model; `token_source` ∈ envelope | adapter | otel.
- `adapt(apiFamily, requestBody?, responseBody?) → Partial<CanonicalFields>` routed by `(vendor, api_family)`; `generic`
  when none matches; adapters never throw (property test); an adapter/envelope disagreement sets `adapter_discrepancy`
  and emits an `adapter_audit` row. Golden fixtures per adapter under `fixtures/`.
- Transform Lambda emits bronze + silver rows per record (`otfMetadata` routing); OTel spans emit `source='otel'` rows.

## 3. SQL (`spec/lakehouse/sql/`, Trino; aliases `t_<table>`; contract-tested against the specs)
`silver_20/21` attribution MERGE (2 d hourly / 90 d daily); `silver_30` bill_daily from `cur_raw` (35 d; parsing per
`bill-parse.ts` + guardrail / provisioned / third-party names); `silver_40` metrics hourly (2 d); `silver_50/51` OTel
dedupe; `quality_60–64` (tokens ≥ 0, model_key present, attribution enum, no body columns, dedupe complete) — empty = pass.

## 4. Infra (`infra/lib/stacks/lakehouse-silver.ts`, additions to `lakehouse-stack.ts`)
Silver S3 Tables tables from the specs; `RegistrySnapshotFn` (hourly, writes `silver.project_registry`, keeps
`is_current`); `DimModelRefreshFn` (daily); `LakehouseSilverSfn` (Athena per SQL file, in order, hourly; daily variant
runs `silver_21`); quality failures → `ExecutionsFailed` → governance topic; Lake Formation grants for the new tables.
`LoggingStack`: `ModelInvocationLoggingConfiguration` becomes an `AwsCustomResource` calling
`PutModelInvocationLoggingConfiguration` (S3 + CloudWatch destinations); Bedrock-logs role resource ARN built without `:*`.

## 5. Verification
`scripts/verify-lakehouse.ts` (TS vs SQL attribution agreement, tenant cardinality < 50, price_status distribution);
Athena `EXPLAIN` of the SQL against dev where tables exist; the P2 test report records the first live SFN run.
