# Plan: DORA metrics dashboard + QA-loop fixes (PR #37)

- **Spec:** ./spec.md
- **Author:** Claude (AI agent)
- **Accepted-by:** Tim WU
- **Accepted-for:** ad1c63ccad84fb8dad0d3d99f6112d1e22f9df97
- **Status:** shipped

`Accepted-for` is the merge-base after updating this branch with main (which by then carried the gate installation). Chain written
retroactively — the change predates the gate's installation; see intent.md.

## Files changed

### DORA domain (new)
1. `backend/lambdas/dora/types.ts` — item shapes + key builders for the tums-dora table
2. `backend/lambdas/dora/dora-calc.ts` — pure DORA math (tiers, cohorts, ISO-week timeline)
3. `backend/lambdas/dora/dora-calc.test.ts`
4. `backend/lambdas/dora/dora-classify.ts` — revert/hotfix/incident + AI-attribution classifiers
5. `backend/lambdas/dora/dora-classify.test.ts`
6. `backend/lambdas/dora/github-client.ts` — fetch-based REST client, pagination, rate-limit floor
7. `backend/lambdas/dora/github-client.test.ts`
8. `backend/lambdas/dora/secret.ts` — PAT from Secrets Manager (placeholder-aware)
9. `backend/lambdas/dora/store.ts` — registry / PR / issue access on tums-dora
10. `backend/lambdas/dora/collector.ts` — seed-once + incremental GitHub sync
11. `backend/lambdas/dora/collector.test.ts`
12. `backend/lambdas/api/dora.ts` — six /v1/dora routes; admin-gated writes
13. `backend/scripts/run-dora-collector-once.ts` — local runner

### Shared (extended)
14. `backend/lambdas/shared/admin.ts` — cognito:groups parser + isAdmin (new)
15. `backend/lambdas/shared/admin.test.ts` (new)
16. `backend/lambdas/shared/response.ts` — forbidden/created/accepted helpers
17. `backend/lambdas/shared/response.test.ts`

### QA-loop fixes on existing surfaces
18. `backend/lambdas/api/usage.ts` — billed input only; cache tokens as own fields (F-001)
19. `backend/lambdas/api/projects.ts` — wall-clock Athena poll within the Lambda timeout (F-002)
20. `backend/lambdas/api/queries.ts` — async `byProject` template (F-002, definitive fix)
21. `backend/lambdas/api/cost-calc.ts` — gpt-5.6-sol + gpt-5 rate entries (F-201)
22. `backend/lambdas/api/cost-calc-openai.test.ts` — regression pin (new)

### Frontend
23. `frontend/src/pages/DoraPage.tsx` — the new page (new)
24. `frontend/src/pages/UsagePage.tsx` — cache KPI, neutral caption, day-carrying labels (F-001/3/4)
25. `frontend/src/pages/ProjectsPage.tsx` — async Full view + totals scaling (F-002, N-001)
26. `frontend/src/api/client.ts` — typed /v1/dora + /v1/queries calls; UsagePoint cache fields
27. `frontend/src/auth/cognito.ts` — isAdminUser()
28. `frontend/src/components/Layout.tsx` — DORA nav entry
29. `frontend/src/lib/format.ts` — fmtHours/fmtPct/fmtAgo/fmtDateTime/fmtAxisHours
30. `frontend/src/main.tsx` — /dora route + page meta
31. `frontend/src/styles.css` — .seg, .btn-sm, badge success/neutral variants

### Infra
32. `infra/bin/infra.ts` — wire the Dora stack
33. `infra/lib/config/types.ts` — `dora` config block
34. `infra/lib/stacks/dora-stack.ts` — GitHub-token secret + scheduled collector (new)
35. `infra/lib/stacks/api-stack.ts` — DoraFn + routes; ProjectsFn 28s timeout; QueriesFn curated-bucket read
36. `infra/lib/stacks/auth-stack.ts` — Cognito `admin` group
37. `infra/lib/stacks/data-stack.ts` — tums-dora table

Non-source riders: `infra/lib/config/ci.json`, `infra/lib/config/example.env.json`,
`backend/package.json`, `backend/package-lock.json` (deps: client-secrets-manager,
client-lambda, and the QA fixes), plus docs (CHANGELOG.md, README.md, AGENTS.md,
docs/ARCHITECTURE.md, docs/ROADMAP.md, docs/test-reports/*).

## Verification

- CI gates green: backend jest (111) + tsc, frontend build, cdk synth env=ci.
- Live dev validation: all API paths (401/403/201/400/404/202), real 180-day backfill of six
  repos, metrics cross-checked against a direct GitHub survey; UI-QA agent loop converged to
  PASS (0 findings) after three rounds. Evidence: docs/test-reports/feature-12-dora-metrics.md.
