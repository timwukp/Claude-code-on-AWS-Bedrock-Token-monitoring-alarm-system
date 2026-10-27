# Plan: lakehouse P1 — bronze (chain 2 of 4)

- **Spec:** ./spec.md
- **Author:** Claude (AI agent)
- **Accepted-by:** Tim WU
- **Accepted-for:** acf8dc7335583bc6069f4a7892d9c18c695b6950
- **Status:** accepted

`Accepted-for` is the tip of `main` after PR #77 (feature-44). The peer's Mantle-metrics chain may land before this one;
if it does, this plan is rebound to the new tip.

## Files changed
1. `spec/lakehouse/README.md`, `spec/lakehouse/bronze.bedrock_invocations.schema.json`, `spec/lakehouse/bronze.cw_metrics.schema.json`, `spec/lakehouse/bronze.otel_spans.schema.json`, `spec/lakehouse/bronze.cur_raw.schema.json` — table specs.
2. `spec/lakehouse/generated/tables.json` — generated column/partition/routing lists.
3. `backend/scripts/gen-lakehouse-ddl.ts` — generator.
4. `backend/lambdas/lakehouse/generated/row-types.ts` — generated row types.
5. `backend/lambdas/lakehouse/generated.test.ts` — spec ↔ artefact consistency.
6. `backend/lambdas/lakehouse/model-id.ts`, `backend/lambdas/lakehouse/model-id.test.ts` — multi-vendor model id parser.
7. `backend/lambdas/lakehouse/tenant-key.ts`, `backend/lambdas/lakehouse/tenant-key.test.ts` — role/user tenant key.
8. `backend/lambdas/lakehouse/metric-stream.ts`, `backend/lambdas/lakehouse/metric-stream.test.ts` — Metric Streams line parser.
9. `backend/lambdas/lakehouse/otel-span.ts`, `backend/lambdas/lakehouse/otel-span.test.ts` — Transaction Search span parser.
10. `backend/lambdas/lakehouse/transform.ts`, `backend/lambdas/lakehouse/transform.test.ts` — Firehose transform (bronze routing).
11. `infra/lib/lakehouse/spec.ts` — reads the generated tables at synth time.
12. `infra/lib/stacks/lakehouse-stack.ts` — the stack.
13. `infra/lib/stacks/logging-stack.ts` — CloudWatch destination + large-body bucket.
14. `infra/lib/stacks/etl-stack.ts` — `PYTHONUNBUFFERED=1` on the ETL container; `infra/lib/stacks/data-stack.ts` — Glue DB `locationUri` for zero-ETL.
15. `infra/bin/infra.ts` — wires the stack and its dependencies.
16. `infra/lib/config/types.ts`, `infra/lib/config/example.env.json`, `infra/lib/config/ci.json` — `lakehouse` block.
17. `infra/test/synth.ts`, `infra/test/lakehouse-stack.test.ts`, `infra/test/logging-stack.test.ts` — assertions.
18. `scripts/create-project-aip.sh` — AIP per project.
19. `scripts/deploy-frontend.sh` — Cognito pre-flight.
20. `scripts/lakehouse-smoke.ts`, `scripts/package.json`, `scripts/package-lock.json`, `scripts/tsconfig.json` — smoke test.

Non-source riders: `.sdlc/active` (handover from `full-view-freshness-copy`), `intent/full-view-freshness-copy/*` → shipped,
`intent/lakehouse-p1-bronze/*`, `CHANGELOG.md`, `AGENTS.md` (repository map), `docs/LAKEHOUSE.md`, `docs/ARCHITECTURE.md`,
`docs/ROADMAP.md`, `docs/MONITORING_APPROACH.md`, `docs/test-reports/feature-45-lakehouse-p1-bronze.md` + index row.

Also: `infra/lib/config/types.ts` gains `logging.createTrail` (dev = false: the account already runs a multi-region trail; `Tums-dev-Logging` had never been deployed).

## Verification
- `cd backend && npm test` + `tsc`; `cd infra && npm test` + `tsc`; `cd backend/analysis && python3 -m unittest test_etl`;
  `cd frontend && npm run build`; `cdk synth --context env=ci` (11 stacks); SDLC gate; `cd scripts && npx tsc --noEmit`.
- `cdk diff` against dev reviewed with the owner (new Lakehouse stack; Logging adds the CloudWatch destination; Etl env).
- After the owner's deploy (Automation → Data → Lakehouse → Logging → Etl → Api): `cd scripts && ENV=dev npx ts-node
  lakehouse-smoke.ts` → 7/7 invocation rows, ≥1 metric row, 0 error objects; a real Bedrock call appears in
  `bronze.bedrock_invocations` within minutes; `bronze.cw_metrics` shows `AWS/BedrockMantle` rows; `aws/spans` events appear in
  `bronze.otel_spans`; the CUR export's first delivery lands within 24 h and `cur_raw` returns rows; Lake Formation denies a
  non-owner principal on bronze.

## Risks
- Firehose → Iceberg is schema-strict: bronze keeps the record in `raw` and types only a handful of keys; failures go to
  the errors bucket and alarm rather than being dropped.
- Lake Formation grants for the S3 Tables federated catalog are the usual blocker; the owner principal is granted first and
  verified in Athena before any other principal.
- Double delivery (S3 + CloudWatch) costs ≈ $1/month at dev volumes and is removed when the aggregator moves to bronze.
- CUR 2.0 first delivery takes up to 24 h; the smoke test does not wait for it.
