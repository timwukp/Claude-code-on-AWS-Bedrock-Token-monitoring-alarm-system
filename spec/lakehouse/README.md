# Lakehouse spec (single source of truth)

Every table in the lakehouse is described once, here, as a JSON Schema document with `x-lakehouse` extensions. From
these files `backend/scripts/gen-lakehouse-ddl.ts` generates (a) the S3 Tables / Glue column lists used by the CDK stack,
(b) TypeScript row types for the transform Lambda, and (c) the Firehose routing table. A jest test fails when a generated
artefact is stale, so the spec and the code cannot drift.

Conventions
- One file per table: `<layer>.<table>.schema.json` (`bronze.bedrock_invocations.schema.json`).
- `properties` are columns in order; `type` ∈ string | integer | number | boolean | timestamp (`{"type":"string","format":"date-time"}`).
- `required` lists NOT NULL columns. Everything else is nullable.
- `x-lakehouse`: `{ "layer", "table", "storage": "s3tables" | "glue-external", "partition": ["day(event_ts)"] | [...], "description", "retention": "forever" | "<n>d", "pii": true|false, "firehoseRoute"?: { "stream": "...", "match": "..." } }`.
- bronze keeps the producer's record verbatim in `raw` (string JSON) plus the few typed keys needed to partition and route.
  bronze is **not** published to SMUS and is readable only by the pipeline roles and the owner (Lake Formation).
- Column names are snake_case; Iceberg types: string, long, double, boolean, timestamp.
