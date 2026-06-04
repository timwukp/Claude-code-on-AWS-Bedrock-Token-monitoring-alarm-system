"""
Heavy ETL job (runs on ECS Fargate, scheduled by Step Functions).

Responsibilities:
  1. Read raw Bedrock model-invocation logs (newline-delimited JSON, gzip) from RAW_LOG_BUCKET.
  2. Normalise the verified schema (see docs/VERIFICATION.md):
        timestamp, accountId, region, requestId, operation, modelId, identity.arn,
        requestMetadata{}, input.{inputTokenCount, cacheReadInputTokenCount,
        cacheWriteInputTokenCount}, output.outputTokenCount
     -- flattening the input/output structs and deriving a `dt=YYYY-MM-DD` date partition.
  3. Write partitioned Parquet to CURATED_BUCKET to cut Athena scan cost (Cost/Performance).

Design mirrors the TS ingestion path (backend/lambdas/ingestion/parse.ts): the parsing/flattening
logic is a PURE function (`parse_log_lines`) with NO AWS calls and NO pandas/pyarrow dependency, so
it can be unit-tested offline (see test_etl.py). Only the S3 list/download and the Parquet write
touch boto3 / pandas / pyarrow, and those imports are deferred so importing this module for tests
needs the stdlib only.

Config comes entirely from the environment (no hardcoded account ids or secrets):
  RAW_LOG_BUCKET   (required)  source bucket holding the raw gzip'd NDJSON logs
  CURATED_BUCKET   (required)  destination bucket for partitioned Parquet
  LOG_PREFIX       (optional)  key prefix to scan; default "model-logs/"
  AWS_REGION       (optional)  region for the S3 client (boto3 resolves it if unset)
"""
import gzip
import json
import os
import sys
from typing import Any, Dict, Iterable, List

DEFAULT_LOG_PREFIX = "model-logs/"


# ---------------------------------------------------------------------------
# PURE logic (no AWS, no pandas) -- unit-testable offline.
# ---------------------------------------------------------------------------

def derive_dt(timestamp: str) -> str:
    """Derive the `dt` date partition (YYYY-MM-DD) from an ISO-8601 timestamp.

    "2026-06-03T06:54:27Z" -> "2026-06-03". We slice rather than parse so a slightly
    off-spec timestamp still yields a usable date prefix.
    """
    return (timestamp or "")[:10]


def _to_int(value: Any) -> int:
    """Coerce a (possibly missing/None/str) token count to a non-negative int, default 0."""
    if value is None:
        return 0
    try:
        return int(value)
    except (TypeError, ValueError):
        return 0


def flatten_record(record: Dict[str, Any]) -> Dict[str, Any]:
    """Flatten one verified invocation record into a flat row for Parquet.

    Missing fields become 0 (token counts) or None (strings). `requestMetadata` is kept as
    JSON text so it survives as a single Parquet column (it's an arbitrary string map).
    """
    inp = record.get("input") or {}
    out = record.get("output") or {}
    identity = record.get("identity") or {}
    metadata = record.get("requestMetadata")

    timestamp = record.get("timestamp")
    return {
        "timestamp": timestamp,
        "dt": derive_dt(timestamp),
        "accountId": record.get("accountId"),
        "region": record.get("region"),
        "requestId": record.get("requestId"),
        "operation": record.get("operation"),
        "modelId": record.get("modelId"),
        "inferenceRegion": record.get("inferenceRegion"),
        "identityArn": identity.get("arn") if isinstance(identity, dict) else None,
        "requestMetadata": json.dumps(metadata) if metadata else None,
        "inputTokenCount": _to_int(inp.get("inputTokenCount")),
        "cacheReadInputTokenCount": _to_int(inp.get("cacheReadInputTokenCount")),
        "cacheWriteInputTokenCount": _to_int(inp.get("cacheWriteInputTokenCount")),
        "outputTokenCount": _to_int(out.get("outputTokenCount")),
    }


def parse_log_lines(text: str) -> List[Dict[str, Any]]:
    """Parse a gzip-decompressed file body (newline-delimited JSON) into flat rows.

    Pure: no AWS, no pandas. Mirrors parseLogFile() in parse.ts.

    - Skips blank and malformed lines rather than failing the whole batch (Reliability).
    - Requires both `requestId` and `timestamp`; records lacking either are skipped (they are
      not usable for partitioning/attribution -- e.g. permission-check probes).
    - Flattens the input/output/identity structs and derives the `dt` date partition.
    """
    rows: List[Dict[str, Any]] = []
    for line in text.split("\n"):
        stripped = line.strip()
        if not stripped:
            continue
        try:
            record = json.loads(stripped)
        except (ValueError, json.JSONDecodeError):
            # Skip malformed lines (truncated/partial writes) -- don't fail the batch.
            continue
        if not isinstance(record, dict):
            continue
        if not record.get("requestId") or not record.get("timestamp"):
            continue
        rows.append(flatten_record(record))
    return rows


def is_skippable_key(key: str) -> bool:
    """True for object keys we must NOT treat as main token-bearing records.

    - `/data/` holds split-out large input bodies (>100 KB); they carry no token counts.
    - `permission-check` markers are probes Bedrock writes when logging is configured.
    """
    return "/data/" in key or "permission-check" in key


# ---------------------------------------------------------------------------
# S3 + Parquet (AWS side) -- deferred imports so the pure logic stays dependency-free.
# ---------------------------------------------------------------------------

def _iter_log_keys(s3, bucket: str, prefix: str) -> Iterable[str]:
    """Yield gzip log object keys under `prefix`, skipping /data/ and permission-check markers."""
    paginator = s3.get_paginator("list_objects_v2")
    for page in paginator.paginate(Bucket=bucket, Prefix=prefix):
        for obj in page.get("Contents", []):
            key = obj["Key"]
            if not key.endswith(".gz"):
                continue
            if is_skippable_key(key):
                continue
            yield key


def _read_object_rows(s3, bucket: str, key: str) -> List[Dict[str, Any]]:
    """Download + gunzip + parse one S3 object into flat rows."""
    body = s3.get_object(Bucket=bucket, Key=key)["Body"].read()
    try:
        text = gzip.decompress(body).decode("utf-8")
    except (OSError, EOFError, UnicodeDecodeError) as exc:
        print(f"  WARN: could not decompress {key}: {exc}", file=sys.stderr)
        return []
    return parse_log_lines(text)


def run_etl(raw_bucket: str, curated_bucket: str, prefix: str, region: str | None) -> Dict[str, int]:
    """List -> download -> parse -> write partitioned Parquet. Returns a summary dict.

    Idempotent-friendly: one Parquet file is written per `dt` partition keyed by a stable hash
    of the source keys, and it's fine to overwrite a day's partition on re-run.
    """
    import boto3  # deferred: only needed on the AWS path
    import pandas as pd

    s3 = boto3.client("s3", region_name=region) if region else boto3.client("s3")

    objects_read = 0
    all_rows: List[Dict[str, Any]] = []
    for key in _iter_log_keys(s3, raw_bucket, prefix):
        rows = _read_object_rows(s3, raw_bucket, key)
        objects_read += 1
        all_rows.extend(rows)

    summary = {"objects_read": objects_read, "rows_written": 0, "partitions_written": 0}
    if not all_rows:
        print(f"ETL done: {objects_read} objects read, 0 rows written (nothing to do).")
        return summary

    df = pd.DataFrame(all_rows)
    partitions = sorted(p for p in df["dt"].dropna().unique() if p)
    for dt in partitions:
        part = df[df["dt"] == dt].drop(columns=["dt"])
        dest = f"s3://{curated_bucket}/usage/dt={dt}/part-0000.parquet"
        part.to_parquet(dest, index=False, engine="pyarrow", compression="snappy")
        summary["rows_written"] += len(part)
        print(f"  wrote {len(part)} rows -> {dest}")

    summary["partitions_written"] = len(partitions)
    print(
        f"ETL done: {objects_read} objects read, {summary['rows_written']} rows written "
        f"across {summary['partitions_written']} partition(s)."
    )
    return summary


def main() -> int:
    raw_bucket = os.environ.get("RAW_LOG_BUCKET")
    curated_bucket = os.environ.get("CURATED_BUCKET")
    if not raw_bucket or not curated_bucket:
        print("RAW_LOG_BUCKET and CURATED_BUCKET must be set", file=sys.stderr)
        return 2

    prefix = os.environ.get("LOG_PREFIX", DEFAULT_LOG_PREFIX)
    region = os.environ.get("AWS_REGION") or None

    print(f"ETL start: raw={raw_bucket} curated={curated_bucket} prefix={prefix}")
    try:
        run_etl(raw_bucket, curated_bucket, prefix, region)
    except Exception as exc:  # noqa: BLE001 -- surface a non-zero exit for the scheduler
        print(f"ETL failed: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
