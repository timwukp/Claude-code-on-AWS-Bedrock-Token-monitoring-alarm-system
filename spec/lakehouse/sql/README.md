# Silver SQL (Trino / Athena)

The silver layer is derived from bronze and the registry by these statements, run by the `LakehouseSilverSfn`
Step Functions workflow (Athena `StartQueryExecution` per file, in file-name order, hourly; the `*_90d` variant daily).
The transform Lambda writes a best-effort silver row at ingest; these statements make silver **recomputable** —
anything here can be re-run over a wider window and converges to the same result.

## Parameters (substituted by the SFN / the smoke scripts, never by Athena)
| placeholder | example (dev) |
|---|---|
| `${CATALOG}` | `"s3tablescatalog/tums-lakehouse-dev"` — already double-quoted; the S3 Tables federated catalog |
| `${GLUE_DB}` | `token_monitoring_dev` — the Glue database holding `cur_raw` and the curated Parquet |
| `${ENV}` | `dev` |

## Alias convention (contract-tested)
Every table reference is aliased `t_<table>` (`t_invocations`, `t_project_registry`, `t_cur_raw`, `t_cw_metrics`, …).
`backend/lambdas/lakehouse/sql-contract.test.ts` resolves every `t_<table>.<column>` against `spec/lakehouse/*.schema.json`,
so a column renamed in the spec fails CI before it fails in Athena. Short aliases (`i`, `r`, `s`) are allowed only for
CTE results, which have no spec.

## Execution order
| file | what | window | writes |
|---|---|---|---|
| `silver_20_attribution_merge.sql` | rule C recompute (AIP ▷ identity ▷ metadata ▷ untagged) from the current registry snapshot | 2 d | `silver.invocations` (UPDATE only when changed) |
| `silver_21_attribution_merge_90d.sql` | same, daily | 90 d | `silver.invocations` |
| `silver_30_bill_daily.sql` | CUR 2.0 lines → day × usage type × line-item type × region, usage type parsed per `bill-parse.ts` (+ guardrail / provisioned / generic third-party names) | 35 d | `silver.bill_daily` |
| `silver_40_metrics_hourly.sql` | Metric Streams datapoints → hourly per namespace / metric / model / project | 2 d | `silver.bedrock_metrics_hourly` |
| `silver_50_otel_dedupe_merge.sql` | fold OTel-only fields into the Bedrock row of the same `request_id`, mark `source='both'` | 2–3 d | `silver.invocations` |
| `silver_51_otel_dedupe_delete.sql` | delete the OTel rows folded by 50 | 2–3 d | `silver.invocations` |
| `quality_6x_*.sql` | gates; each returns offending rows, **empty = pass** (the SFN fails the run and alarms when any returns rows) | 2 d | — |

`silver_10_registry_current` is intentionally absent: the registry-snapshot Lambda keeps `is_current` itself.

Attribution precedence note: the SQL implements rule C as the owner decided on 2026-10-24 (AIP ▷ identity ▷ metadata).
The legacy aggregator (`parse.ts deriveProject`) still orders metadata before identity; `scripts/verify-lakehouse.ts`
reports such rows as "precedence-only" disagreements. Aligning the aggregator is a P3 item.

`bill_daily.kind` includes `cache_write_30m` (OpenAI's single 30-minute TTL, billed like the 5-minute Claude TTL) in
addition to the enumeration in the spec description; `route` uses `other` where `bill-parse.ts` says `unknown`.

## Validation status (2026-10-30, dev)
Silver tables do not exist until the P2 stack deploys, so Athena could validate only the parts that read existing
tables. Validated with `EXPLAIN` against dev: the `silver_30` source (over `token_monitoring_dev.cur_raw`), the
`silver_40` source (over `bronze.cw_metrics`), the `quality_63` information-schema probe (run against bronze — it
found `input_body_s3_path`, exactly the shape it exists to catch). The usage-type parsing CASE was executed on eight
real usage-type names through `VALUES` and classified every one as `bill-parse.ts` does. **Validated after deploy**:
`silver_20/21` (needs `silver.project_registry` + `silver.invocations`), `silver_50/51`, `quality_60–62/64`, and the
MERGE clauses themselves. The P2 test report records the first live run.

## Running one by hand
Athena console → workgroup `token-monitoring-<env>` → paste the file with the three placeholders replaced. For a
MERGE/DELETE prefer `EXPLAIN <statement>` first; it checks names and types without writing.
