# Feature 45 — Lakehouse P1: bronze layer (S3 Tables + Firehose + Metric Streams + CUR + OTel ingress)

- **Chain:** `intent/lakehouse-p1-bronze/` · **Branch:** `feat/lakehouse-p1-bronze` off `main@acf8dc7` (#77) · **PR:** #79
- **Date:** 2026-10-27 · **Verdict:** PASS on gates; deploy + smoke test pending the owner's authorisation (Data, Lakehouse, Logging, Etl).

## What this report has to say plainly
- **Spec first, generated second.** Four `spec/lakehouse/*.schema.json` files are the only definition of the bronze tables;
  the CDK stack builds S3 Tables schemas from them at synth time and the backend generates row types + a JSON mirror from
  them. A test fails byte-for-byte if either generated artefact is stale.
- **Firehose takes one JSON object per record** (AWS doc, "Considerations and limitations"). The bedrock stream therefore
  chains Decompression → CloudWatchLogProcessing → Lambda so one log event is one record; any record that still carries
  N rows re-ingests the overflow with `PutRecordBatch`, and anything unparsable lands in the errors bucket — never dropped.
- **The Logging stack had never been deployed in dev** (found by `cdk diff`: every resource `[+]`); Bedrock logging was
  configured by CLI. This chain makes the CloudTrail trail optional (`logging.createTrail`, dev = false, the account already
  runs a multi-region trail) so deploying Logging only adds the CloudWatch destination. The `ModelInvocationLoggingConfiguration`
  is an account singleton: if CloudFormation refuses to create it over the CLI-made one, `cdk import` it (runbook in LAKEHOUSE.md).
- **Three forks, zero shared files**, integrated by one agent: infra (20 → 21 tests), backend (426 → 516), scripts/docs.

## Scope (see `intent/lakehouse-p1-bronze/plan.md` for the full file list)
| Area | Delivered |
|---|---|
| `spec/lakehouse/` | README + bronze.bedrock_invocations / cw_metrics / otel_spans (S3 Tables) / cur_raw (Glue external); `generated/tables.json` |
| `infra/lib/stacks/lakehouse-stack.ts`, `infra/lib/lakehouse/spec.ts` | table bucket `tums-lakehouse-<env>`, namespaces bronze/silver/gold, 3 bronze tables (identity partition on `*_day`, snapshots never expire), bodies/errors/cur buckets, Bedrock CW log group + role, 2 transform Lambdas, 2 Firehose Iceberg streams (processor chains), subscriptions (bedrock group + `aws/spans`), Metric Stream, optional Transaction Search, CUR 2.0 export + `cur_raw` projection table, zero-ETL ×2, Lake Formation grants, 6 alarms |
| `infra/lib/stacks/logging-stack.ts`, `data-stack.ts`, `etl-stack.ts`, `bin/infra.ts`, config | CloudWatch destination + large-body bucket; optional trail; Glue DB `locationUri`; `PYTHONUNBUFFERED=1`; `lakehouse`/`logging` config blocks |
| `backend/lambdas/lakehouse/` | `model-id.ts` (60 cases, all vendors/id forms), `tenant-key.ts`, `metric-stream.ts`, `otel-span.ts` (real `aws/spans` shape + OTLP/JSON), `transform.ts` (routing via `otfMetadata`, re-ingest, never throws), `generated/row-types.ts` |
| `backend/scripts/gen-lakehouse-ddl.ts` | spec → generated artefacts |
| `scripts/` | `create-project-aip.sh` (AIP per project + settings.json snippet), `deploy-frontend.sh` pre-flight, `lakehouse-smoke.ts` (+ own package.json) |
| docs | `docs/LAKEHOUSE.md` (new), ARCHITECTURE, ROADMAP (#78), MONITORING_APPROACH, AGENTS.md |

## Gates
| Gate | Result |
|---|---|
| backend jest | 516 / 516 (38 suites) |
| backend tsc | PASS |
| infra jest | 21 / 21 (5 suites) |
| infra tsc / `cdk synth --context env=ci` (11 stacks) | PASS |
| `test_etl` | 23 / 23 |
| frontend build | PASS (no frontend change) |
| SDLC gate | PASS |
| `cdk diff` dev | Data: KMS grant for S3 Tables maintenance + Glue DB `LocationUri`; **Lakehouse: new stack** (1 table bucket, 3 namespaces, 3 tables, 4 buckets, 2 Firehose, 2 Lambda, metric stream, CUR export, cur_raw, 2 zero-ETL, 8 LF grants, 6 alarms); Logging: new in dev (logging config with CloudWatch destination; no trail); Etl: env only |

## Live — after the owner's deploy (to fill)
- `cd scripts && npm install && ENV=dev npx ts-node lakehouse-smoke.ts` → 7 invocation rows + ≥1 metric row in bronze, errors bucket unchanged.
- Real traffic: bronze.bedrock_invocations row count grows within minutes of a Bedrock call; `aws/spans` rows appear for OTel-instrumented callers.
- CUR export: first Parquet under `cur2/tums-cur2-dev/data/BILLING_PERIOD=2026-10/` within 24 h; `SELECT count(*) FROM cur_raw`.
