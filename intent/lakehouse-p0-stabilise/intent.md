# Intent: the Full view cannot be killed by a body file, and a failing ETL is heard

- **Slug:** lakehouse-p0-stabilise
- **Author:** Claude (AI agent)
- **Date:** 2026-10-24
- **Accepted-by:** Tim WU
- **Status:** accepted

## Problem

P0 of the lakehouse programme (plan `floating-enchanting-kahan`, approved 2026-10-24). Three faults found on 2026-10-23/24:

1. **Every Full-view query failed** (qa F-PR75-001). The Glue table `bedrock_invocation_logs` sits on Bedrock's own delivery
   prefix, which also holds the >100 KB request/response bodies under `data/` (180,935 objects, 40.1 GB of the table's 41.7 GB).
   On 2026-10-23 ~15:xx UTC the first OpenAI Responses-API bodies (`us.openai.gpt-6-luna`, top-level `input` = an array of
   messages) were coerced positionally by the OpenX SerDe into the table's `input` struct —
   `HIVE_BAD_DATA … 'inputtokencount' … UnmodifiableMap can not be coerced to an INTEGER`. No SerDe or schema change
   survives every legal body shape (tested: `ignore.malformed.json`, string-typed counts, the Hive SerDe).
2. **The curated layer never existed.** The daily Fargate ETL that should feed Athena with flat Parquet failed 90 of 90
   executions since 2026-07-27 (`exec /usr/local/bin/python: exec format error` — an arm64 image on an x86_64 task) and
   had no alarm. The ETL also relists the whole prefix (300k keys) on every run.
3. **Nothing tells the operator** when the state machine fails.

## Desired outcome

- The API's Athena templates read a table that contains only parsed records — the ETL's Parquet under
  `usage/dt=YYYY-MM-DD/` — defined in CDK with partition projection; the raw-prefix table is no longer queried by the app.
- The ETL image is built for the architecture the task runs on; a failed execution raises a CloudWatch alarm on the
  governance SNS topic; the daily run processes only the days since its watermark (plus the previous day) and tolerates
  any body shape in a record.
- A regression test exists for every one of the three faults, and the infra now has a jest harness so CDK changes are
  asserted before they are deployed.

## Out of scope (later chains)

Bronze/silver/gold Iceberg tables, Firehose, Metric Streams, CUR, zero-ETL, OTel, SMUS registration (P1–P3). The three
Responses-API bodies of 2026-10-23 stay where they are unless the owner moves them; after this chain the app does not
read that prefix, so they are inert.
