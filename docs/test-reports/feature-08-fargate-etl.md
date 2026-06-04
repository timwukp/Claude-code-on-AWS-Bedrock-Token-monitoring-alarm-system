# Test Report — Feature #8: Fargate ETL implementation

| | |
|---|---|
| Issue | #8 |
| Branch | `feat/fargate-etl` |
| Date | 2026-06-04 |
| Environment | Local (pure parser unit-tested); real-AWS Parquet run pending |
| Result | **PASS (unit)** — code complete; real-AWS S3→Parquet run pending |

## Scope

Implement the ETL job (`backend/analysis/etl.py`) that compacts raw Bedrock invocation logs
(gzipped NDJSON) into partitioned Parquet to cut Athena scan cost. Mirror the TS ingestion
pattern: a pure, offline-testable parser separated from the S3/Parquet (boto3/pandas) path.

## Implementation

- **Pure layer (stdlib only):** `parse_log_lines(text)` → flat rows; `flatten_record` (flattens
  input/output/identity structs, keeps `requestMetadata` as JSON text, coerces missing/non-numeric
  token counts to 0); `derive_dt` (timestamp → `YYYY-MM-DD`); `is_skippable_key` (skips `/data/`
  large-body splits and `permission-check` markers). Malformed/blank/non-object lines and records
  missing `requestId`/`timestamp` are skipped without failing the batch.
- **AWS layer (deferred imports of boto3/pandas/pyarrow):** `run_etl` paginates `list_objects_v2`
  under `LOG_PREFIX`, downloads+gunzips+parses, writes one snappy Parquet file per `dt` partition
  to `s3://CURATED_BUCKET/usage/dt=YYYY-MM-DD/`. Config from env (`RAW_LOG_BUCKET`,
  `CURATED_BUCKET`, `LOG_PREFIX`, `AWS_REGION`); no hardcoded account ids.

## Unit tests

`cd backend/analysis && python3 test_etl.py` → **8/8 PASS** (stdlib `unittest`).
`python3 -m py_compile etl.py` → PASS. Cases: NDJSON parsing; malformed/blank/non-object
skipping; missing-required-field skipping; input/output token flattening; zero/None defaults;
non-numeric coercion; date-partition derivation; `/data/` + permission-check key skipping.

## Caveat / pending

The pure parser is fully tested offline (no pandas needed). The **S3→Parquet path
(`run_etl`/`main`) requires boto3/pandas/pyarrow** (already in `requirements.txt` for the
container) and was **not executed against real AWS** here. Real-AWS validation (deploy the Etl
stack, run against the live raw-log bucket, confirm Parquet partitions land in the curated
bucket) is the remaining step — ROADMAP #8 stays 🟡 until then.

## Verdict

ETL logic implemented and unit-tested offline. Real-AWS Parquet run pending — see ROADMAP #8.
