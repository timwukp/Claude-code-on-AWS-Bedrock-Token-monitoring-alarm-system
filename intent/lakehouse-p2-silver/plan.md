# Plan: lakehouse silver (chain 3 of 4)

- **Spec:** ./spec.md
- **Author:** Claude (AI agent)
- **Accepted-by:** Tim WU
- **Accepted-for:** a7f6ff78c5ce082e9c2ed99e14451bf1dac25bc1
- **Status:** accepted

`Accepted-for` is the tip of `main` after PR #111 (dependabot minors; #108 ci-dependabot-tamed before it). Nothing else is in flight.

## Files changed
1. `spec/lakehouse/silver.invocations.schema.json`, `silver.dim_model.schema.json`, `silver.bill_daily.schema.json`, `silver.bedrock_metrics_hourly.schema.json`, `silver.project_registry.schema.json`, `silver.adapter_audit.schema.json` — the silver specs.
2. `spec/lakehouse/generated/tables.json` — regenerated.
3. `spec/lakehouse/sql/silver_20_attribution_merge.sql`, `silver_21_attribution_merge_90d.sql`, `silver_30_bill_daily.sql`, `silver_40_metrics_hourly.sql`, `silver_50_otel_dedupe_merge.sql`, `silver_51_otel_dedupe_delete.sql`, `quality_60_tokens_nonnegative.sql`, `quality_61_model_key_present.sql`, `quality_62_attribution_enum.sql`, `quality_63_no_body_columns.sql`, `quality_64_dedupe_complete.sql`, `README.md` — silver derivation and gates.
4. `backend/scripts/gen-lakehouse-ddl.ts` — silver support.
5. `backend/lambdas/lakehouse/canonical.ts` — canonical row + value order.
6. `backend/lambdas/lakehouse/adapters/index.ts`, `backend/lambdas/lakehouse/adapters/types.ts`, `backend/lambdas/lakehouse/adapters/anthropic.ts`, `backend/lambdas/lakehouse/adapters/openai.ts`, `backend/lambdas/lakehouse/adapters/converse.ts`, `backend/lambdas/lakehouse/adapters/vendors.ts` (meta, mistral, cohere, ai21, titan-embeddings, generic), `backend/lambdas/lakehouse/adapters/otel.ts` — vendor adapters; golden fixtures under `backend/lambdas/lakehouse/fixtures/adapters/`.
7. `backend/lambdas/lakehouse/transform.ts` (+ test) — silver path, adapter routing, attribution best-effort.
8. `backend/lambdas/lakehouse/dim-model-refresh.ts` (+ test) — `silver.dim_model`.
9. `backend/lambdas/lakehouse/registry-snapshot.ts` (+ test) — `silver.project_registry`.
10. `backend/lambdas/lakehouse/sql-contract.test.ts` — `t_<table>.<col>` ↔ spec.
11. `backend/lambdas/lakehouse/generated.test.ts`, `backend/lambdas/lakehouse/generated/row-types.ts`, `backend/lambdas/lakehouse/otel-span.ts` — regenerated / extended.
12. `backend/package.json` — dependencies for the new Lambdas.
13. `infra/lib/stacks/lakehouse-silver.ts`, `infra/lib/lakehouse/pending-handler.ts` — silver tables, Lambdas, SFN, grants, alarms.
14. `infra/lib/stacks/lakehouse-stack.ts` — wiring; Bedrock-logs role ARN without `:*`.
15. `infra/lib/stacks/logging-stack.ts` — custom resource for the logging configuration.
16. `infra/bin/infra.ts`, `infra/lib/config/types.ts`, `infra/lib/config/example.env.json`, `infra/lib/config/ci.json` — wiring and config.
17. `infra/test/lakehouse-stack.test.ts`, `infra/test/logging-stack.test.ts`, `infra/test/synth.ts` — assertions.
18. `scripts/verify-lakehouse.ts`, `scripts/package.json` — dual-run verification.

Non-source riders: `.sdlc/active` (handover from `ci-dependabot-tamed`), `intent/ci-dependabot-tamed/*` → shipped,
`intent/lakehouse-p2-silver/*`, `CHANGELOG.md`, `AGENTS.md`, `docs/LAKEHOUSE.md`, `docs/GOVERNANCE-ATTRIBUTION.md`
(new), `docs/ARCHITECTURE.md`, `docs/ROADMAP.md`, `docs/test-reports/feature-45-lakehouse-p1-bronze.md` (live
section), `docs/test-reports/feature-49-lakehouse-p2-silver.md` + index row.

## Verification
- `cd backend && npm test` + `tsc`; `cd infra && npm test` + `tsc`; `cdk synth --context env=ci`; `test_etl`; frontend build; SDLC gate.
- Athena `EXPLAIN` of the bronze/cur_raw-reading SQL against dev (silver-touching statements validate after deploy).
- After the owner's deploy (Lakehouse, Logging): first `LakehouseSilverSfn` run SUCCEEDED, quality gates empty;
  `scripts/verify-lakehouse.ts` PASS (attribution agreement 100 % excluding precedence-only, tenants < 50).

## Risks
- Trino MERGE on S3 Tables: first live run may surface type mismatches the EXPLAIN could not (silver tables absent in dev
  before deploy) — the SFN fails loudly and the SQL is re-runnable.
- The legacy aggregator orders metadata before identity; silver follows rule C — documented, measured by the verify script.
