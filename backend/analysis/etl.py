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
  ETL_MODE         (optional)  "incremental" (default) processes the days since the watermark stored at
                               s3://CURATED_BUCKET/usage/_etl_watermark.json, always re-reading the previous
                               day; "full" relists the whole prefix (first run / repair).
"""
import concurrent.futures
import datetime as _dt
import gzip
import json
import os
import sys
from typing import Any, Dict, Iterable, List, Optional, Tuple

DEFAULT_LOG_PREFIX = "model-logs/"

# Parquet column types, in Glue terms. The Glue table `bedrock_invocations_curated` (infra
# data-stack.ts) declares exactly these; `dt` is the partition key. A partition where every
# requestMetadata is None would otherwise be written as a Parquet NULL-typed column and fail to
# read as string in Athena, so dtypes are forced before writing.
CURATED_COLUMNS: Dict[str, str] = {
    "timestamp": "string",
    "accountId": "string",
    "region": "string",
    "requestId": "string",
    "operation": "string",
    "modelId": "string",
    "inferenceRegion": "string",
    "identityArn": "string",
    "requestMetadata": "string",
    "inputTokenCount": "bigint",
    "cacheReadInputTokenCount": "bigint",
    "cacheWriteInputTokenCount": "bigint",
    "outputTokenCount": "bigint",
}
_PANDAS_DTYPE = {"string": "string", "bigint": "int64"}
WATERMARK_KEY = "usage/_etl_watermark.json"
READ_CONCURRENCY = 16


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
        n = int(value)
    except (TypeError, ValueError, OverflowError):  # OverflowError: float('inf') from a 1e309 literal
        return 0
    # A billing log never carries negative or absurd counts; treat them as absent rather than let one
    # record skew a day (the TypeScript twin is `safeCount` in lambdas/ingestion/parse.ts).
    return n if 0 <= n <= 2**53 else 0


def flatten_record(record: Dict[str, Any]) -> Dict[str, Any]:
    """Flatten one verified invocation record into a flat row for Parquet.

    Missing fields become 0 (token counts) or None (strings). `requestMetadata` is kept as
    JSON text so it survives as a single Parquet column (it's an arbitrary string map).
    """
    # A foreign body shape (e.g. an OpenAI Responses request whose `input` is an array) must not
    # raise -- counts fall back to 0 and the row stays, exactly as the Athena table could not do.
    inp = record.get("input") if isinstance(record.get("input"), dict) else {}
    out = record.get("output") if isinstance(record.get("output"), dict) else {}
    identity = record.get("identity") if isinstance(record.get("identity"), dict) else {}
    metadata = record.get("requestMetadata") if isinstance(record.get("requestMetadata"), dict) else None

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
        "identityArn": identity.get("arn"),
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


def _parse_day(text: str) -> Optional[_dt.date]:
    try:
        return _dt.date.fromisoformat(text)
    except (TypeError, ValueError):
        return None


def plan_days(watermark_day: Optional[str], today: str, lookback_days: int = 1) -> Optional[List[str]]:
    """Days to (re)process for an incremental run, oldest first; None means "full backfill".

    The previous day is always included so hour files that land after midnight are picked up --
    partitions are overwritten, so re-reading a day is idempotent.
    """
    if watermark_day is None:
        return None
    start, end = _parse_day(watermark_day), _parse_day(today)
    if start is None or end is None:
        return None
    start = min(start, end - _dt.timedelta(days=lookback_days))
    return [(start + _dt.timedelta(days=i)).isoformat() for i in range((end - start).days + 1)]


def day_prefix(log_root: str, day: str) -> str:
    """`<root>YYYY/MM/DD/` -- the layout Bedrock writes under the region prefix."""
    return f"{log_root}{day[0:4]}/{day[5:7]}/{day[8:10]}/"


def read_watermark(text: str) -> Optional[str]:
    try:
        day = json.loads(text).get("last_day")
    except (ValueError, AttributeError):
        return None
    return day if isinstance(day, str) and _parse_day(day) else None


def write_watermark_text(last_day: str) -> str:
    return json.dumps({"last_day": last_day, "updated_at": _dt.datetime.now(_dt.timezone.utc).isoformat()})


def split_rows_by_window(rows: List[Dict[str, Any]], days: List[str]) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]]]:
    """Rows whose dt is one of the processed days, and the rest (written on a later run)."""
    window = set(days)
    inside = [r for r in rows if r.get("dt") in window]
    outside = [r for r in rows if r.get("dt") not in window]
    return inside, outside


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


def _discover_log_root(s3, bucket: str, prefix: str) -> Optional[str]:
    """Walk `<prefix>AWSLogs/<account>/BedrockModelInvocationLogs/<region>/` with delimiter listings.

    One account and one region per bucket is the deployed shape; if several exist the first is
    taken and the rest are reported, so the operator sees it rather than silently losing a region.
    """
    root = prefix if prefix.endswith("/") else prefix + "/"
    for expected in ("AWSLogs/", None, "BedrockModelInvocationLogs/", None):
        page = s3.list_objects_v2(Bucket=bucket, Prefix=root, Delimiter="/")
        children = [c["Prefix"] for c in page.get("CommonPrefixes", [])]
        if expected is not None:
            children = [c for c in children if c.endswith(expected)]
        if not children:
            return None
        if len(children) > 1:
            print(f"  WARN: several prefixes under {root}: {children}; using {children[0]}", file=sys.stderr)
        root = children[0]
    return root


def _read_watermark(s3, bucket: str) -> Optional[str]:
    try:
        body = s3.get_object(Bucket=bucket, Key=WATERMARK_KEY)["Body"].read().decode("utf-8")
    except Exception:  # noqa: BLE001 -- NoSuchKey on the first run; any read problem means "full"
        return None
    return read_watermark(body)


def _write_watermark(s3, bucket: str, last_day: str) -> None:
    s3.put_object(Bucket=bucket, Key=WATERMARK_KEY, Body=write_watermark_text(last_day).encode("utf-8"),
                  ContentType="application/json")


def run_etl(raw_bucket: str, curated_bucket: str, prefix: str, region: str | None,
            mode: str = "incremental", today: Optional[str] = None) -> Dict[str, int]:
    """List -> download -> parse -> write partitioned Parquet. Returns a summary dict.

    Incremental (default): reads only the day prefixes since the watermark (plus the previous day)
    and rewrites those partitions; rows whose dt falls outside the processed days are set aside
    for the run that covers their day. Full: relists the whole prefix (first run / repair).
    """
    import boto3  # deferred: only needed on the AWS path
    import pandas as pd
    from botocore.config import Config

    pool_cfg = Config(max_pool_connections=READ_CONCURRENCY * 2)
    s3 = boto3.client("s3", region_name=region, config=pool_cfg) if region else boto3.client("s3", config=pool_cfg)
    today = today or _dt.datetime.now(_dt.timezone.utc).date().isoformat()

    days: Optional[List[str]] = None
    if mode != "full":
        days = plan_days(_read_watermark(s3, curated_bucket), today)
    log_root = _discover_log_root(s3, raw_bucket, prefix) if days else None
    if days and not log_root:
        print(f"  WARN: could not find the Bedrock log root under {prefix}; falling back to a full scan", file=sys.stderr)
        days = None
    list_prefixes = [day_prefix(log_root, d) for d in days] if days and log_root else [prefix]
    print(f"ETL mode: {'incremental ' + str(days) if days else 'full'}")

    keys = [k for p in list_prefixes for k in _iter_log_keys(s3, raw_bucket, p)]
    objects_read = len(keys)
    all_rows: List[Dict[str, Any]] = []
    # ~125k objects on a full backfill: sequential GETs would take ~1.7 h against a 2 h task timeout.
    with concurrent.futures.ThreadPoolExecutor(max_workers=READ_CONCURRENCY) as pool:
        for rows in pool.map(lambda k: _read_object_rows(s3, raw_bucket, k), keys):
            all_rows.extend(rows)

    summary = {"objects_read": objects_read, "rows_written": 0, "partitions_written": 0, "rows_deferred": 0}
    if days:
        all_rows, deferred = split_rows_by_window(all_rows, days)
        summary["rows_deferred"] = len(deferred)
    if not all_rows:
        print(f"ETL done: {objects_read} objects read, 0 rows written (nothing to do).")
        if days:
            _write_watermark(s3, curated_bucket, days[-1])
        return summary

    df = pd.DataFrame(all_rows)
    for col, glue_type in CURATED_COLUMNS.items():
        if col not in df.columns:
            df[col] = None
        df[col] = df[col].astype(_PANDAS_DTYPE[glue_type])
    partitions = sorted(p for p in df["dt"].dropna().unique() if p)
    for dt in partitions:
        part = df[df["dt"] == dt].drop(columns=["dt"])[list(CURATED_COLUMNS)]
        dest = f"s3://{curated_bucket}/usage/dt={dt}/part-0000.parquet"
        part.to_parquet(dest, index=False, engine="pyarrow", compression="snappy")
        summary["rows_written"] += len(part)
        print(f"  wrote {len(part)} rows -> {dest}")

    summary["partitions_written"] = len(partitions)
    _write_watermark(s3, curated_bucket, days[-1] if days else max(partitions))
    print(
        f"ETL done: {objects_read} objects read, {summary['rows_written']} rows written "
        f"across {summary['partitions_written']} partition(s), {summary['rows_deferred']} deferred."
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
    mode = os.environ.get("ETL_MODE", "incremental")

    print(f"ETL start: raw={raw_bucket} curated={curated_bucket} prefix={prefix} mode={mode}")
    try:
        run_etl(raw_bucket, curated_bucket, prefix, region, mode=mode)
    except Exception as exc:  # noqa: BLE001 -- surface a non-zero exit for the scheduler
        print(f"ETL failed: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
