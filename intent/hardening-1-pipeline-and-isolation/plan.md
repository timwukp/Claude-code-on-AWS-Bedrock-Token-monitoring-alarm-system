# Plan: hardening 1 — pipeline and isolation (feature-47)

- **Spec:** ./spec.md
- **Author:** Claude (AI agent)
- **Accepted-by:** Tim WU
- **Accepted-for:** b2851fe9a4bad0750906800b054b62ed96f9fa2e
- **Status:** accepted

`Accepted-for` is the tip of `main` after PR #82 (lakehouse-p1-zero-etl-flag); the only chain in flight. Plan approved by the
owner on 2026-10-28 (plan-mode review of the two-chain hardening programme; this is chain 1 of 2).

## Files changed
1. Ingestion: `backend/lambdas/ingestion/parse.ts`, `backend/lambdas/ingestion/parse.test.ts`, `backend/lambdas/ingestion/aggregator.ts`,
   `backend/lambdas/ingestion/aggregator-plan.test.ts` (new), `backend/lambdas/shared/logged-estimate.ts`, `backend/scripts/seed-tenant-index.ts`,
   `backend/analysis/etl.py`, `backend/analysis/test_etl.py`, `backend/analysis/Dockerfile`
2. API: `backend/lambdas/api/queries.ts`, `backend/lambdas/api/queries.test.ts`, `backend/lambdas/api/projects.ts`
3. CI: `.github/workflows/ui-qa-agent.yml`, `.github/workflows/deploy.yml`, `.github/workflows/sdlc-gate.yml`, `.github/workflows/ci.yml`,
   `.github/dependabot.yml` (new), `ci-agent/qa_agent.py`, `ci-agent/bugfix_agent.py`, `ci-agent/test_agents.py` (new)
4. Infra: `infra/lib/config/types.ts`, `infra/lib/stacks/frontend-stack.ts`, `infra/lib/stacks/auth-stack.ts`, `infra/lib/stacks/api-stack.ts`,
   `infra/lib/stacks/data-stack.ts`, `infra/lib/stacks/automation-stack.ts`, `infra/lib/stacks/dora-stack.ts`, `infra/lib/stacks/etl-stack.ts`,
   `infra/lib/stacks/lakehouse-stack.ts`, `infra/package.json`, `infra/package-lock.json`, `infra/test/synth.ts`,
   `infra/test/security.test.ts` (new), `infra/test/lakehouse-stack.test.ts`
5. Frontend/scripts: `frontend/src/auth/cognito.ts`, `frontend/vite.config.ts`, `frontend/src/pages/ProjectsPage.tsx`, `scripts/deploy-frontend.sh`
6. Docs: `docs/MULTI_TENANCY.md`, `SECURITY.md`, `CHANGELOG.md`, `docs/test-reports/feature-47-hardening-1-pipeline-and-isolation.md` (new),
   `docs/test-reports/feature-46-mantle-counts-persisted.md` (Live table filled), `docs/test-reports/README.md`
7. SDLC: `intent/hardening-1-pipeline-and-isolation/intent.md`, `intent/hardening-1-pipeline-and-isolation/spec.md`,
   `intent/hardening-1-pipeline-and-isolation/plan.md`, `.sdlc/active`, `intent/lakehouse-p1-zero-etl-flag/intent.md`,
   `intent/lakehouse-p1-zero-etl-flag/spec.md`, `intent/lakehouse-p1-zero-etl-flag/plan.md` (→ shipped)

## Order
parse sanitisation → aggregator per-object loop + tenant items + userSet cap → listTenants / migration script → queries binding →
CI agents + workflows → CDK (headers, auth, CORS, TTL, runtimes, bump) + infra tests → frontend token store / maps → docs →
gates → push → PR → qa → owner deploys **Data** (TTL attribute + deletion protection — in-place), **Etl** (code), **Api** (code +
one IAM grant on the aggregates table for QueriesFn), **Auth** (client validity — users re-login once; pool threat protection =
Plus tier), **Frontend** (response-headers policy) → run `seed-tenant-index.ts --apply` → live checks → owner merge → chain 2.

## Verification
Backend jest + tsc; `python3 -m unittest test_etl` and `test_agents`; frontend tsc + build; infra jest (security invariants) +
`cdk synth -c env=ci`; actionlint on all workflows; SDLC gate; leak scan. Live: per spec Acceptance.

## Risks
- Auth client change logs every user out once (tokens re-issued with the new validity). Plus tier adds a small per-MAU Cognito charge.
- CSP is report-only on dev first; the owner flips `frontend.cspEnforce` after a clean console round.
- The QA workflow's auto-fix now patches a `pr/` checkout and pushes with the job's `contents: write` token; `main` is protected
  by the Phase 0 ruleset, so that token cannot land code anywhere but the PR branch.
- The idempotency markers start empty: the first post-deploy run re-reads the 1-minute overlap window only (watermark is
  preserved), so no double counting is introduced by the switch.
