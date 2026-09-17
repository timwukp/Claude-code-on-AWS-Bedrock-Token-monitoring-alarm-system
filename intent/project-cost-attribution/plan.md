# Plan: project cost attribution × DORA join (feature-13)

- **Spec:** ./spec.md
- **Author:** Claude (AI agent)
- **Accepted-by:** Tim WU
- **Accepted-for:** 41a127158e2e37780ea377c0314b428ae3a2f400
- **Status:** shipped

`Accepted-for` is main's tip after PR #37 (the DORA feature this joins against) merged; this
branch is cut from it. Design approved in plan mode 2026-09-17 with four owner decisions
(daily rollups; DORA-page panel; repo settings pilot; opt-in IAM construct).

## Files changed

### Pure core (new)
1. `backend/lambdas/ingestion/parse.ts` — deriveProject precedence, AttributionMaps,
   dayBucketOf, aggregateByProjectDay; aggregate/aggregateByProject key on the effective model
2. `backend/lambdas/ingestion/parse-attribution.test.ts` (new)
3. `backend/lambdas/shared/project-registry.ts` (new) — registry store + validation + seeding
4. `backend/lambdas/shared/project-registry.test.ts` (new)
5. `backend/lambdas/api/project-calc.ts` (new) — pooled Delivery×Cost rows, projdayRange
6. `backend/lambdas/api/project-calc.test.ts` (new)
7. `backend/lambdas/api/cost-calc-arn.test.ts` (new) — opaque-AIP-ARN pricing guard

### Runtime
8. `backend/lambdas/ingestion/aggregator.ts` — load maps, resolve unseen profile ARNs,
   negative cache, PROJDAY writes
9. `backend/lambdas/api/project-registry.ts` (new) — registry CRUD Lambda (admin writes)
10. `backend/lambdas/api/dora.ts` — GET /v1/dora/projects (+ PROJDAY window query)
11. `backend/lambdas/api/projects.ts` — registry name join + per-model pricing on the fast path
12. `backend/scripts/backfill-projday.ts` (new) — one-off historical PROJDAY backfill

### Infra
13. `infra/lib/stacks/projects-stack.ts` (new) — tagged AIPs per project×model; opt-in
    enforcement policy + pilot role
14. `infra/lib/stacks/etl-stack.ts` — aggregator TENANTS_TABLE env + grants + Bedrock
    Get/ListTags IAM
15. `infra/lib/stacks/api-stack.ts` — ProjectRegistryFn + routes; doraFn/projectsFn grants
16. `infra/bin/infra.ts` — wire the Projects stack
17. `infra/lib/config/types.ts` — `projects` config block

### Frontend
18. `frontend/src/api/client.ts` — RegistryProject/DoraProjectRow types + 4 calls
19. `frontend/src/pages/DoraPage.tsx` — "Projects — delivery × cost" panel; KPI labels/footers rewritten in plain
    language (owner review: "0.90/day" was not understandable — now "6.3 / week · 27 merged PRs in 30 days")
20. `frontend/src/pages/ProjectsPage.tsx` — registry names + admin registry panel
21. `frontend/src/main.tsx` — By-Project page subtitle names the real attribution mechanisms
    (inference profiles, request metadata, registry) instead of the retired CSV-only wording
22. `backend/lambdas/api/queries.ts` — the async `byProject` Athena template prices per model
    from RATE_CARD (single pricing source) and resolves application-inference-profile ARNs via
    the registry cache, so the Full view agrees with the Fast view and the Cost page — QA
    findings F-402 / F-501 raised against this feature's By-Project changes

Non-source riders: `infra/lib/config/ci.json`, `infra/lib/config/example.env.json`,
`backend/package.json`, `backend/package-lock.json` (dep: @aws-sdk/client-bedrock),
`.claude/settings.json.example` (pilot template), `.sdlc/active` (pointer handover),
`intent/dora-metrics-dashboard/*` (marked shipped), `intent/project-cost-attribution/*`
(this chain), docs (CHANGELOG.md, README.md, docs/ARCHITECTURE.md, docs/ROADMAP.md,
docs/ATTRIBUTION.md, docs/test-reports/README.md,
docs/test-reports/feature-13-project-cost-attribution.md,
docs/research-project-cost-dora-attribution.md).

## Verification

- Gates: backend jest (132) + tsc, frontend build, cdk synth env=ci (11 stacks incl.
  Tums-ci-Projects) — all green on this tree before any push.
- Live (dev): deploy Data/Etl/Projects/Api; registry seeds `token-monitoring`; aggregator
  resolves the three new AIP ARNs; PROJDAY rows appear; backfill fills history idempotently;
  `GET /v1/dora/projects?window=90` returns the project row with pooled DORA + cost;
  IAM pilot role: invoke via tagged AIP = Allow, direct model ids = AccessDenied (records
  which ARN `bedrock:InferenceProfileArn` matched — the deep-research open question).
- Results recorded in docs/test-reports/feature-13-project-cost-attribution.md.
