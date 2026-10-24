# Incident: the Full view died on a body file, and the curated layer had never existed (2026-07-27 → 2026-10-24)

- **Severity:** high — the By project "Full (Athena + names)" view and every `/v1/queries` template failed for every
  user from 2026-10-23 ~15:40 UTC; separately, the daily ETL meant to feed Athena had failed on all 90 runs since
  2026-07-27 with nobody told.
- **Detected:** 2026-10-23 by the UI qa agent on PR #75 (finding F-PR75-001). The ETL failure was found while tracing it.
- **Fixed by:** `lakehouse-p0-stabilise` (this document); the structural redesign is the lakehouse programme (P1–P3).
- **Data loss:** none. Raw logs were never touched; the Fast (DynamoDB) view was unaffected.

## What was wrong

**1. The analytics table sat on the delivery prefix.** `bedrock_invocation_logs` (hand-made DDL, `docs/MONITORING_APPROACH.md`)
had `LOCATION = s3://<raw>/model-logs/AWSLogs/<acct>/BedrockModelInvocationLogs/<region>/`. Bedrock writes two kinds of
object under that prefix: the gzipped NDJSON log batches, and — for any request/response body over 100 KB — the body
itself, as its own object under `…/YYYY/MM/DD/HH/data/`. Athena scans a LOCATION recursively, so every query read both.

| Measured 2026-10-24 (dev account) | |
|---|---|
| Objects under the table prefix | 306,718 |
| of which body objects (`data/`) | **180,935 — 40.1 GB of 41.7 GB (96 %)** |
| Full-view query time / cost | 25–30 s / ≈ $0.20 |
| Code that reads bodies from S3 | none (`aggregator.ts` and `etl.py` skip `/data/`) |

**2. One body shape collided with the schema.** For months the bodies were Anthropic/Converse requests whose top-level
keys (`messages`, `system`, …) match nothing in the table, so they parsed as all-null rows and fell out of every WHERE.
On 2026-10-23 at 14:xx–15:xx UTC the first three **OpenAI Responses-API** request bodies arrived (`us.openai.gpt-6-luna`,
caller `assumed-role/ltg-asean-sim-HostRole`). A Responses request has a top-level `input` that is an **array of
messages**. The table declares `input` as `struct<inputContentType, inputBodyS3Path, inputTokenCount:int, …>`, and the
OpenX SerDe maps an array onto a struct **by position**: `input[2]` (a message object) landed in `inputTokenCount:int`:

```
HIVE_BAD_DATA: Error parsing column 'inputtokencount' with value '{type=message, id=msg_…, role=user, content=[{type=input_text, …}]}'
… 'java.lang.RuntimeException: Invalid JSON: UnmodifiableMap can not be coerced to an INTEGER'
```

Tested on scratch tables and rejected: `ignore.malformed.json` (type coercion is not "malformed"); counts typed `string`
with `try_cast` (survives the array but dies on `input: "a plain string"`, also legal: `Primitive can not be coerced to a
ROW`); the Hive `JsonSerDe` (`Start of Object expected`). A Responses *response* over 100 KB would collide the same way
through its top-level `output` array. **No schema-only fix is robust; the app must not read that prefix.**

**3. The layer that should have protected us was never built.** `backend/analysis/etl.py` flattens records into Parquet
under `s3://<curated>/usage/dt=…/` — exactly the table the app should query. Its Fargate task failed every day:

```
exec /usr/local/bin/python: exec format error
```

The image was built on an Apple-silicon laptop (arm64) and the task definition ran on x86_64. 90 executions since
2026-07-27, 0 successes, 0 Parquet files, no alarm. Each run also relisted the whole prefix (300k keys).

## Root cause

Two coupled decisions: (a) pointing the analytics table at a prefix the producer also uses for binary/body
delivery; (b) treating the ETL as optional — no alarm, no test of the artefact it produced, and the Full view wired to
the raw table "until the ETL works". The 2026-10-23 trigger was simply the first caller to use a vendor API whose request
shape overlaps the record schema. Any vendor, any day, could have been the one.

## Fix (this chain)

- The API's Athena templates read `bedrock_invocations_curated` (CDK-defined, Parquet, partition projection on `dt`) through
  one adapter module (`backend/lambdas/api/invocation-source.ts`); the raw table is no longer queried by the app.
- ETL image built `linux/amd64`, task `runtimePlatform` X86_64; a failed execution alarms on the governance SNS topic.
- ETL runs incrementally from a watermark, tolerates any body shape inside a record, and reads with a thread pool.
- Regression tests for all three faults; a jest harness for the infra (none existed).

## Lessons

1. **Never share a prefix between a producer's binary delivery and an analytics table.** Separate buckets, or a layer
   (ETL/Firehose) that writes only typed records.
2. **A scheduled job without an alarm is a job you believe in, not one you have.** Every Step Functions / Lambda schedule
   gets `ExecutionsFailed`/`Errors` → SNS.
3. **Test the artefact, not the job.** The curated table now has a test for its shape; P1 adds a smoke test that writes
   through the pipeline and reads back.
4. **Multi-vendor is a data-shape problem first.** Silver (P2) adopts a vendor-neutral canonical schema with per-vendor
   adapters so a new vendor cannot change what a table looks like.
