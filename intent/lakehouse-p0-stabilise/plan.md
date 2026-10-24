# Plan: P0 stabilise (lakehouse, chain 1 of 4)

- **Spec:** ./spec.md
- **Author:** Claude (AI agent)
- **Accepted-by:** Tim WU
- **Accepted-for:** e08ae195024ec1e28bd060f8f49626625f7b4d38
- **Status:** shipped

`Accepted-for` is the tip of `main` after PR #74 (feature-41). PR #75 (feature-42) is parked by the owner and not on
main; its UI work is carried into lakehouse P3.

## Files changed
1. `backend/lambdas/api/invocation-source.ts` — the table/column adapter (curated default, raw break-glass).
2. `backend/lambdas/api/invocation-source.test.ts` — adapter spec.
3. `backend/lambdas/api/projects.ts` — `buildFullSql` reads through the adapter.
4. `backend/lambdas/api/projects-sql.test.ts` — source-aware assertions; curated/raw switch tests.
5. `backend/lambdas/api/queries.ts` — templates read through the adapter; `dt` pruning.
6. `backend/lambdas/api/queries.test.ts` — source-aware assertions; "every template reads curated" test.
7. `backend/analysis/etl.py` — incremental watermark, tolerant flattening, thread-pooled reads, forced dtypes.
8. `backend/analysis/test_etl.py` — foreign-body, incremental-plan and schema tests.
9. `infra/lib/stacks/data-stack.ts` — `bedrock_invocations_curated` Glue table with partition projection.
10. `infra/lib/stacks/etl-stack.ts` — image platform, runtime platform, failure alarm, `alertTopic` prop.
11. `infra/lib/stacks/api-stack.ts` — `INVOCATION_SOURCE=curated`.
12. `infra/bin/infra.ts` — passes `automation.alertTopic` to the Etl stack.
13. `infra/jest.config.js` — infra test harness.
14. `infra/test/synth.ts` — stack fixture for tests.
15. `infra/test/etl-stack.test.ts` — ETL assertions.
16. `infra/test/data-stack.test.ts` — curated table assertions.
17. `.github/workflows/ci.yml` — CI runs `cd infra && npm test` and the ETL `unittest`.

Non-source riders: `.sdlc/active` (handover from `openai-rates-and-unpriced`), `intent/openai-rates-and-unpriced/*` →
shipped, `intent/lakehouse-p0-stabilise/*`, `CHANGELOG.md`, `docs/incidents/2026-10-athena-body-collision.md`,
`docs/MONITORING_APPROACH.md` (table section), `docs/test-reports/feature-43-lakehouse-p0-stabilise.md` + index row,
`AGENTS.md` (validation gates gain `cd infra && npm test` and the ETL unittest), `.gitignore` (tsc output under `infra/`).

## Verification
- `cd backend && npm test` (422) + `tsc`; `cd infra && npm test` (6) + `tsc`; `cd backend/analysis && python3 -m unittest test_etl` (23);
  `cd frontend && npm run build`; `cdk synth --context env=ci`; SDLC gate.
- `cdk diff` against dev reviewed (Data +1 table, Api env, Etl alarm + task replacement, Automation export).
- After the owner's deploy: one state-machine run succeeds (full backfill); `/projects` Full view returns rows and no
  Athena error; `/v1/queries` templates return; forced failure alarms.

## Risks
- First run is a full backfill of ~125k objects; the thread pool keeps it well inside the 2 h timeout. If it does not,
  the alarm says so and `ETL_MODE=full` can be re-run manually.
- Curated rows lag raw by up to a day (daily schedule) until P1 streams; the Full view already labels its scan time.
