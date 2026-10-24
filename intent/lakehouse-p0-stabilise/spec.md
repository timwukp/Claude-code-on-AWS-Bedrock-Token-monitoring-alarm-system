# Spec: P0 stabilise — curated table, working ETL, alarm

- **Intent:** ./intent.md
- **Author:** Claude (AI agent)
- **Accepted-by:** Tim WU
- **Status:** shipped

## 1. Invocation source adapter (`backend/lambdas/api/invocation-source.ts`)
- `InvocationSource { name, table, inputTokens(a), outputTokens(a), cacheReadTokens(a), cacheWriteTokens(a), identityArn(a),
  modelId(a), timestamp(a), meta(a, key), tenantPredicate(a, tenant), recentDays(a, days) }`.
- `CURATED_SOURCE` (default): table `bedrock_invocations_curated`; counts `COALESCE(l.<col>, 0)`; `meta` →
  `json_extract_scalar(l.requestMetadata, '$.<key>')`; `recentDays` → `AND l.dt >= date_format(date_add('day', -N, current_date), '%Y-%m-%d')`.
- `RAW_SOURCE` (break-glass, `INVOCATION_SOURCE=raw`): the previous nested expressions; `recentDays` → ''.
- `meta()` rejects non-identifier keys (the key is interpolated). `tenantPredicate` keeps the aggregator rule
  `COALESCE(requestMetadata.tenant, identity.arn) = tenant`.
- `projects.ts buildFullSql` and every `queries.ts` template obtain all table/column spellings from the adapter; semantics
  (attribution tiers, rate CASEs, route factor, grouping) are unchanged and their existing tests still pass.

## 2. Curated Glue table (`infra/lib/stacks/data-stack.ts`)
- `AWS::Glue::Table bedrock_invocations_curated` in `token_monitoring_<env>`: EXTERNAL, Parquet (MapredParquetInputFormat /
  ParquetHiveSerDe, SNAPPY), LOCATION `s3://<curated>/usage/`, partition key `dt string`, projection `date`, `yyyy-MM-dd`,
  range `2026-06-01,NOW`, template `s3://<curated>/usage/dt=${dt}/`. Columns = `etl.py CURATED_COLUMNS`
  (`timestamp, accountId, region, requestId, operation, modelId, inferenceRegion, identityArn, requestMetadata` string;
  `inputTokenCount, cacheReadInputTokenCount, cacheWriteInputTokenCount, outputTokenCount` bigint).
- Api Lambdas get `INVOCATION_SOURCE=curated` (explicit, so the switch is visible in IaC).

## 3. ETL (`backend/analysis/etl.py`, `infra/lib/stacks/etl-stack.ts`)
- Image `ContainerImage.fromAsset(…, { platform: LINUX_AMD64 })`; task `runtimePlatform` X86_64/LINUX.
- `ETL_MODE=incremental` (default): watermark `s3://<curated>/usage/_etl_watermark.json` `{last_day}`; `plan_days(wm, today)`
  = every day from `min(wm, today−1)` to today; list only `<root>YYYY/MM/DD/` prefixes (root discovered by delimiter
  listing: `AWSLogs/<acct>/BedrockModelInvocationLogs/<region>/`); rows whose `dt` is outside the processed days are
  deferred; partitions rewritten; watermark advanced to the last processed day. No watermark or `ETL_MODE=full` → whole prefix.
- `flatten_record` tolerates non-dict `input`/`output`/`identity`/`requestMetadata` (counts 0, strings null).
- Reads use a 16-thread pool (`READ_CONCURRENCY`) with a matching botocore connection pool.
- dtypes forced to `CURATED_COLUMNS` before `to_parquet` (an all-null string column must not become a Parquet NULL type).
- Alarm: `StateMachine.metricFailed` Sum/1 h ≥ 1, `notBreaching`, action = `AutomationStack.alertTopic` (new Etl prop).

## 4. Tests
- `infra/jest.config.js`, `infra/test/synth.ts` (CI config, bundling disabled), `infra/test/etl-stack.test.ts`
  (platform in the asset manifest + RuntimePlatform, alarm shape and action, schedule/env), `infra/test/data-stack.test.ts`
  (table columns/formats, projection parameters, no table on the raw prefix).
- `backend/lambdas/api/invocation-source.test.ts`; `projects-sql.test.ts` and `queries.test.ts` made source-aware and
  extended with "reads the curated table / prunes by dt / switches wholesale with INVOCATION_SOURCE=raw".
- `backend/analysis/test_etl.py`: Responses-API array/string bodies and Anthropic/Converse bodies are not records; a record
  with an array `input` yields zero counts without raising; `data/` keys skipped; `plan_days`, `day_prefix`, watermark
  round-trip, `split_rows_by_window`; `CURATED_COLUMNS` ↔ `flatten_record` keys.

## 5. Deploy & verify (owner)
`cdk diff` shows: Data +Glue table; Api +env on 12 Lambdas (+ ProjectsFn/QueriesFn code); Etl +alarm, task definition
replaced (RuntimePlatform), new image; Automation +topic export. After deploy: start the state machine once (full backfill,
~125k objects, minutes with the thread pool), then `/projects` Full view returns rows; a forced failure
(`ETL_MODE=full` with a bad bucket name) raises the alarm e-mail.
