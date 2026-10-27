# Spec: lakehouse P1 — bronze

- **Intent:** ./intent.md
- **Author:** Claude (AI agent)
- **Accepted-by:** Tim WU
- **Status:** signed-off

## 1. Table specs (`spec/lakehouse/`, single source of truth)
- `README.md` conventions; one `<layer>.<table>.schema.json` per table with `x-lakehouse { layer, table, storage, partition,
  retention, pii, firehoseRoute? }`. P1 files: `bronze.bedrock_invocations`, `bronze.cw_metrics`, `bronze.otel_spans`,
  `bronze.cur_raw`.
- `backend/scripts/gen-lakehouse-ddl.ts` generates `spec/lakehouse/generated/tables.json` (S3 Tables / Glue column lists +
  partition + routing) and `backend/lambdas/lakehouse/generated/row-types.ts`; `backend/lambdas/lakehouse/generated.test.ts`
  fails when either is stale. `infra/lib/lakehouse/spec.ts` reads `tables.json` at synth time.

## 2. LakehouseStack (`infra/lib/stacks/lakehouse-stack.ts`)
- `AWS::S3Tables::TableBucket` `tums-lakehouse-<env>` (SSE-KMS where supported); `CfnNamespace` bronze/silver/gold;
  `CfnTable` per bronze spec with `icebergSchema.schemaFieldList` from the spec (lowercase names, required flags),
  partition on the day column, compaction + snapshot management enabled, **no snapshot expiry that drops data**
  (retention forever).
- Buckets: `tums-lakehouse-bodies-<env>-<acct>` (large bodies; KMS; versioned; no lifecycle), `tums-lakehouse-errors-<env>-<acct>`
  (Firehose failures; 90-day expiry), `tums-lakehouse-cur-<env>-<acct>` (CUR 2.0 Parquet; bucket policy for
  `bcm-data-exports.amazonaws.com` and `billingreports.amazonaws.com`).
- Log groups `/tums/<env>/bedrock-invocations` (retention 30 d — bronze is the durable copy) with a resource policy
  for `bedrock.amazonaws.com`; subscription filters on it and on `aws/spans` → Firehose `tums-lakehouse-<env>-bedrock`
  (role with `firehose:PutRecord*`).
- Firehose `tums-lakehouse-<env>-bedrock` and `tums-lakehouse-<env>-metrics`: `IcebergDestinationConfiguration` with
  `catalogConfiguration.catalogArn = arn:aws:glue:<region>:<acct>:catalog/s3tablescatalog/tums-lakehouse-<env>`,
  `destinationTableConfigurationList` for the bronze tables, Lambda processor (`LakehouseTransformFn`, bronze path),
  buffering ≤ 60 s / 1 MB, `s3Configuration` → errors bucket prefix `errors/<stream>/`, CloudWatch logging on.
  Records are routed by the Lambda's `metadata.otfMetadata { destinationDatabaseName, destinationTableName }`.
- `AWS::CloudWatch::MetricStream` (JSON, include `AWS/Bedrock` + `AWS/BedrockMantle`) → the metrics stream.
- `AWS::XRay::TransactionSearchConfig` (indexing 1 %) — idempotent with the account's existing setting.
- `AWS::BCMDataExports::Export` `tums-cur2-<env>`: CUR 2.0, `TIME_GRANULARITY=DAILY`, `INCLUDE_RESOURCES=TRUE`,
  Parquet, OVERWRITE, S3 prefix `cur2/`; query selects exactly the `cur_raw` spec columns. Glue `CfnTable cur_raw` in
  `token_monitoring_<env>` with partition projection `billing_period` (`yyyy-MM`, `2026-06,NOW`) over
  `s3://<cur bucket>/cur2/tums-cur2-<env>/data/BILLING_PERIOD=${billing_period}/`.
- Lake Formation: `CfnResource` registering the table bucket (federated); `CfnPrincipalPermissions`: transform Lambda
  role + Firehose roles → ALL on `bronze` tables; `lakehouse.ownerPrincipalArn` → SELECT/DESCRIBE on `bronze`.
- DataZone: `CfnDataSource` (type GLUE, `token_monitoring_<env>` + the S3 Tables catalog) in `lakehouse.smusDomainId`
  / `smusProjectId` — registration only, no publish.
- Alarms → `AutomationStack.alertTopic`: Firehose `DeliveryToIceberg.Success < 1` / `DataFreshness > 900 s` per stream,
  errors bucket `NumberOfObjects` growth (via `PutObject` EventBridge rule → alarm metric), transform Lambda `Errors ≥ 1`.
- Config: `EnvConfig.lakehouse { smusDomainId, smusProjectId, ownerPrincipalArn }` (types, example, ci.json placeholders);
  stack skipped when the block is absent? No — required; ci.json carries placeholders.

## 3. LoggingStack
- `AWS::Bedrock::ModelInvocationLoggingConfiguration` adds `CloudWatchConfig { LogGroupName, RoleArn,
  LargeDataDeliveryS3Config { BucketName: bodies bucket } }`; `S3Config` unchanged.

## 4. Transform Lambda (`backend/lambdas/lakehouse/transform.ts`, pure logic + thin handler)
- Decodes the Firehose event; each record is either a CloudWatch Logs envelope (gzip+base64; skip `CONTROL_MESSAGE`;
  one output per `logEvents[].message`) or a Metric Streams JSON line. Bedrock records → `bronze.bedrock_invocations`
  rows; `aws/spans` events → `bronze.otel_spans`; metric lines → `bronze.cw_metrics`. Output = newline JSON per row
  with `otfMetadata`; anything unparseable → `ProcessingFailed`. Helpers: `model-id.ts`, `tenant-key.ts`,
  `metric-stream.ts`, `otel-span.ts` (pure, tested).

## 5. Scripts
- `scripts/create-project-aip.sh [--dry-run] <project> <model>...` — idempotent AIP creation, `tums-project` tag,
  settings snippet.
- `scripts/deploy-frontend.sh` — pre-flight on `frontend/.env.local` vs the Auth stack's user pool.
- `scripts/lakehouse-smoke.ts` (+ `scripts/package.json`) — end-to-end smoke; see `docs/LAKEHOUSE.md`.

## 6. ETL / docs riders
- `backend/analysis/Dockerfile` or task env: `PYTHONUNBUFFERED=1` so container logs stream.
- `docs/LAKEHOUSE.md` (new), `docs/ARCHITECTURE.md` §3.5a + stack table, `docs/ROADMAP.md` Tier 5, `docs/MONITORING_APPROACH.md` note.
