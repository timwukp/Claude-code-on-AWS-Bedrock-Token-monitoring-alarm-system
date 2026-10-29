# Spec: hardening 1 — pipeline and isolation

- **Intent:** ./intent.md
- **Author:** Claude (AI agent)
- **Accepted-by:** Tim WU
- **Status:** signed-off

## Behaviour
1. `backend/lambdas/ingestion/parse.ts` — `safeCount(v)` (non-negative safe integer else 0); `sanitizeCounts(record)` applied in
   `parseLogFile` to `input.inputTokenCount`, `input.cacheReadInputTokenCount`, `input.cacheWriteInputTokenCount`,
   `output.outputTokenCount`.
2. `backend/lambdas/ingestion/aggregator.ts` — `LIST_OVERLAP_MS` (60 s) re-list window; `planObjects(listed, processed)` pure:
   drop `/data/`, `permission-check`, processed keys; oldest first, key order on ties. Per object: parse → resolve profiles →
   aggregate → upserts → `recordTenants` (new tenants only, `SYSTEM#TENANT/<tenant>` PutItem) → `markProcessed`
   (`SYSTEM#PROCESSED/<key>`, `expiresAt` +30 d) → `setWatermark` when the object is newer. `usersToAdd(incoming, size, cap=500)`
   → `{add, overflow}`; `upsertProjectRollup` reads the current `userSet` size, adds within the cap, sets `userSetOverflow`.
   Returns `{filesProcessed, aggregatesWritten, skipped}`.
3. `backend/lambdas/shared/logged-estimate.ts` `listTenants()` — Query `SYSTEM#TENANT`; legacy `SYSTEM#TENANTS/all` fallback
   until migrated. `backend/scripts/seed-tenant-index.ts` — scan PROJDAY partitions ∪ legacy list → per-tenant items, delete
   the legacy item (`--apply`).
4. `backend/lambdas/api/projects.ts` — fast rows carry `usersCapped`; `frontend/src/pages/ProjectsPage.tsx` shows `N+`.
5. `backend/analysis/etl.py` `_to_int` — catches `OverflowError`, rejects negative / > 2^53.
6. `backend/lambdas/api/queries.ts` — `templateFor(name)` (`Object.hasOwn`), `daysFor(raw)` (finite, 1–90, default 7);
   `startQuery` writes `QUERY#<tenant>/<executionId>` (`expiresAt` +24 h) when `AGGREGATES_TABLE` is set; `pollQuery(event,
   tenantId)` 404s without a binding. `infra/lib/stacks/api-stack.ts` grants `dynamodb:PutItem`/`GetItem` on aggregates.
7. `.github/workflows/ui-qa-agent.yml` — three jobs as in the intent; workflow `permissions: contents: read`; `qa` job
   `id-token: write, contents: write, pull-requests: write`; fix step runs the agent with `--repo-root pr`, stages only
   listed non-protected paths inside `pr/`, pushes `HEAD:$HEAD_REF`; gate reddens on `FAIL` or `BLOCKING == true`;
   `s3 sync … --exclude "*.map"`. `ci-agent/qa_agent.py` `normalize_report` derives `overall` from findings (UNKNOWN kept).
   `ci-agent/bugfix_agent.py` — `PROTECTED_PREFIXES`, `diff_paths`, `diff_is_confined`, `apply_patch(diff, root, rel)` reverts
   anything but `rel`. `ci-agent/test_agents.py` (stdlib). `.github/workflows/deploy.yml` — `environment: production`,
   `if: main`, `DEPLOY_ENV` validated `^[a-z0-9-]{1,32}$`. `sdlc-gate.yml` `base_ref` via env. All actions SHA-pinned;
   `.github/dependabot.yml`; `backend/analysis/Dockerfile` digest-pinned; `ci.yml` runs `test_agents`.
8. `infra/lib/stacks/frontend-stack.ts` — `ResponseHeadersPolicy` (HSTS 1 y incl. subdomains, nosniff, DENY, referrer
   strict-origin-when-cross-origin, XSS-protection, `Permissions-Policy`, CSP report-only or enforced per
   `cfg.frontend.cspEnforce` — `infra/lib/config/types.ts`). CSP: `default-src 'self'; script-src 'self'; style-src 'self'
   'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self' <api origin> https://cognito-idp.<region>.amazonaws.com;
   frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'`.
9. `infra/lib/stacks/auth-stack.ts` — `featurePlan PLUS` + `standardThreatProtectionMode FULL_FUNCTION`, `deletionProtection`,
   `mfaSecondFactor {sms, otp}`; client `idToken/accessToken 1 h`, `refreshToken 1 d`, `preventUserExistenceErrors`,
   `disableOAuth`. `infra/lib/stacks/api-stack.ts` — synth throws without `api.allowedOrigins` when `env ∉ {dev, ci}`.
   `infra/lib/stacks/data-stack.ts` — `timeToLiveAttribute: 'expiresAt'`, `deletionProtection: true`. All `NODEJS_20_X` →
   `NODEJS_22_X`. `infra/package.json` aws-cdk-lib ^2.275.0 / aws-cdk ^2.1146.1.
10. `frontend/src/auth/cognito.ts` — `cognitoUserPoolsTokenProvider.setKeyValueStorage(sessionStorage adapter)`;
    `frontend/vite.config.ts` `sourcemap: 'hidden'`; `scripts/deploy-frontend.sh` excludes `*.map`.
11. `infra/test/synth.ts` builds Auth/Dora/Api/Frontend too; `infra/test/security.test.ts` (14 invariants);
    `infra/test/lakehouse-stack.test.ts` expects nodejs22.x.
12. Docs: `docs/MULTI_TENANCY.md` deployment assumption + trust boundary; `SECURITY.md` trust boundaries.

## Acceptance
- Unit: backend jest (new: planObjects ×4, usersToAdd ×4, safeCount ×3, templateFor/daysFor ×2); `test_etl` `_to_int` ×2;
  `test_agents` ×10; infra jest 36 incl. 14 security invariants. Synth 11 stacks. actionlint clean.
- Live after deploys: `SYSTEM#TENANT` count == legacy list (2,715); invoking the aggregator twice in a row writes nothing
  the second time (`skipped == listed`); `GET /v1/queries/<id started by another tenant>` → 404; `curl -I` shows the
  headers; Cognito client validity 60/60/1440; `s3control` / ruleset / role trust per Phase 0.

## Out of scope
Everything listed under Non-goals in the intent.
