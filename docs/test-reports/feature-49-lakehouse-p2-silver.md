# Feature 49 — Lakehouse P2: silver layer (vendor-neutral invocations, attribution recompute, bill/metrics folds)

- **Chain:** `intent/lakehouse-p2-silver/` · **Branch:** `feat/lakehouse-p2-silver` off `main@ef912c9` (#108) · **PR:** #112
- **Date:** 2026-10-30 · **Verdict:** PASS on gates; deploy (Lakehouse, Logging) + `verify-lakehouse.ts` pending the owner.

## What this report has to say plainly
- **One row shape for every vendor.** `silver.invocations` uses the OpenTelemetry GenAI vocabulary plus AWS extensions; the
  Bedrock envelope is authoritative for tokens, a per-vendor adapter fills only what the envelope lacks, and every
  disagreement is written to `silver.adapter_audit` instead of silently picked. Twelve golden fixtures (real, redacted
  Anthropic invoke/stream, Converse, OpenAI Responses, embeddings, OTel GenAI spans) validate against the JSON Schema; a
  property test feeds adversarial bodies to every adapter and asserts it never throws.
- **Attribution is recomputable.** The transform attributes best-effort at ingest; an hourly Step Functions job re-runs
  rule C (AIP ▷ identity ▷ metadata) in SQL against the hourly registry snapshot, so registering a role today fixes the
  last 90 days tomorrow. `verify-lakehouse.ts` dual-runs the TypeScript rules against the SQL result and fails under 100 %
  agreement. Known, measured, documented: the legacy aggregator orders metadata before identity — P3 aligns it.
- **OTel rows merge with Bedrock rows** on `request_id` (source `both`); OTel-only rows survive (the only per-call view of Mantle).
- **Logging becomes real IaC.** `AWS::Bedrock::ModelInvocationLoggingConfiguration` is not a CloudFormation type; the stack
  now uses a custom resource, and the Bedrock logs role ARN no longer carries the `:*` that broke validation in dev.
- Hardening items taken from the peer's review: gunzip output capped at 64 MiB; re-ingest table names validated against the spec.

## Scope (full list in `intent/lakehouse-p2-silver/plan.md`)
| Area | Delivered |
|---|---|
| `spec/lakehouse/silver.*.schema.json` (6) + `generated/` | invocations, dim_model, bill_daily, bedrock_metrics_hourly, project_registry, adapter_audit |
| `backend/lambdas/lakehouse/` | `canonical.ts`, `adapters/*` (anthropic, openai, converse, meta, mistral, cohere, ai21, titan-embeddings, otel, generic), `transform.ts` silver path + hardening, `dim-model-refresh.ts`, `registry-snapshot.ts`, `quality-gate.ts`, `athena-writer.ts`, `sql-contract.test.ts` |
| `spec/lakehouse/sql/` | `silver_20/21` attribution MERGE (2 d / 90 d), `silver_30` bill_daily from CUR (bill-parse rules ported), `silver_40` metrics hourly, `silver_50/51` OTel dedupe, `quality_60–64`; README |
| `infra/lib/stacks/lakehouse-silver.ts` (new), `lakehouse-stack.ts` | 6 silver tables, SilverJobsRole/SilverSfnRole + LF grants, DimModelRefreshFn (daily), RegistrySnapshotFn (hourly), QualityGateFn, LakehouseSilverSfn (hourly: silver_* then quality_* + gate), Firehose bedrock stream → silver.invocations/adapter_audit, 4 alarms, DataZone DataSource behind `enableSmusPublish` |
| `infra/lib/stacks/logging-stack.ts` | custom resource for the logging configuration; no onDelete |
| `scripts/verify-lakehouse.ts` | dual-run attribution equivalence, tenant cardinality, price_status distribution |
| docs | `docs/GOVERNANCE-ATTRIBUTION.md` (new), LAKEHOUSE (silver), ARCHITECTURE, ROADMAP, AGENTS |

## Gates
| Gate | Result |
|---|---|
| backend jest | 585 / 585 (45 suites; +69) |
| backend tsc | PASS |
| infra jest | 46 / 46 (+22) |
| infra tsc / `cdk synth --context env=ci` | PASS |
| `test_etl` | 23 / 23 |
| frontend build | PASS (no change) |
| SDLC gate | PASS |
| `cdk diff` dev | Lakehouse: +6 tables, +32 LF grants, +4 Lambdas, +1 SFN, +3 rules, +4 alarms, 2 Firehose updated (silver destinations), **0 replacements**; Logging: first create (custom resource) |
| SQL validation | `silver_30`/`silver_40` sources and the usage-type CASE EXPLAIN-validated on dev; silver-touching MERGEs validate after deploy |

## Live — after the owner's deploy (to fill)
- SFN first run green; `quality_*` gates pass; `verify-lakehouse.ts` agreement %, tenant count (< 50), price_status split.
- `silver.invocations` row count ≈ bronze (minus duplicates); OTel `both` rows appear for gateway traffic.
