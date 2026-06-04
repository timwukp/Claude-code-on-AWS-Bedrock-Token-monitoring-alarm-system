"""
Heavy ETL job (runs on ECS Fargate, scheduled by Step Functions).

Responsibilities:
  1. Read raw Bedrock model-invocation logs (newline-delimited JSON, gzip) from RAW_LOG_BUCKET.
  2. Normalise the verified schema:
        timestamp, modelId, requestId, requestMetadata{}, input.inputTokenCount,
        output.outputTokenCount  (NOTE: no IAM identity field — attribute via requestMetadata)
  3. Write partitioned Parquet to CURATED_BUCKET to cut Athena scan cost (Cost/Performance).
  4. (Optional) emit compliance/usage reports.

This is a runnable skeleton: the read/transform/write steps are marked TODO so the deployment
owner can wire in the actual S3 paths and partition layout confirmed for their bucket.
"""
import os
import sys


def main() -> int:
    raw_bucket = os.environ.get("RAW_LOG_BUCKET")
    curated_bucket = os.environ.get("CURATED_BUCKET")
    if not raw_bucket or not curated_bucket:
        print("RAW_LOG_BUCKET and CURATED_BUCKET must be set", file=sys.stderr)
        return 2

    print(f"ETL start: raw={raw_bucket} curated={curated_bucket}")
    # TODO 1: list new objects under model-logs/AWSLogs/<account>/BedrockModelInvocationLogs/
    # TODO 2: parse gzipped newline-delimited JSON into a DataFrame
    # TODO 3: select verified fields; flatten input/output structs; derive date partitions
    # TODO 4: df.to_parquet(s3://CURATED_BUCKET/usage/dt=YYYY-MM-DD/..., partition_cols=[...])
    print("ETL skeleton complete. Replace TODOs with real logic.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
