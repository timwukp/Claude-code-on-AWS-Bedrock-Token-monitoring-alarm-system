# Intent: hardening 1 — the pipeline cannot be wedged or poisoned, and CI runs no PR code with credentials

- **Slug:** hardening-1-pipeline-and-isolation
- **Author:** Claude (AI agent)
- **Date:** 2026-10-28
- **Accepted-by:** Tim WU
- **Status:** shipped

## Problem
A read-only security audit (2026-10-28; five reviewers + live checks; report kept outside the public repo) found the
external surface sound — every API route Cognito-authorised, no injection or XSS, `tenantId` immutable, buckets closed —
and the risk concentrated in three under-defended entries:

1. **Anyone who calls Bedrock in the account writes into the pipeline.** `requestMetadata` values become DynamoDB keys and
   set members; the tenant index was ONE item at ~341 KB of DynamoDB's 400 KB ceiling (2,715 session ARNs, +15/day);
   the aggregator's `ADD` upserts ran before its watermark moved, so a failing write would re-add every counter on every
   15-minute retry, forever. A `1e309` token count or a string would have thrown at the marshaller the same way.
2. **A pull request's code ran with AWS credentials and a `contents: write` token** (`ui-qa-agent.yml` checked out the
   head ref and executed its build scripts, agents and redactor); the QA agent's own `overall: PASS` was trusted even with
   findings; the bug-fix agent's diff was applied to every file it named while only one was checked.
3. **`GET /v1/queries/{id}` returned any Athena execution's rows** to any authenticated user; the SPA kept Cognito
   id/access/refresh tokens in localStorage for 30 days behind a CloudFront distribution that sent no security headers.

Owner decisions folded in: single-organisation deployment (registries stay global; sensitive fields admin-only — Phase 2);
`requestMetadata.tenant` stays cooperative and is documented as such; MFA stays optional but threat protection,
username-enumeration prevention and deletion protection are on.

## Desired outcome
- Aggregator processes one S3 object at a time: aggregate → upsert → `SYSTEM#PROCESSED/<key>` (TTL 30 d) → watermark; a
  retry skips processed objects; tenants are `SYSTEM#TENANT/<tenant>` items; `userSet` stops at 500 (`userSetOverflow`);
  the four billed counters are sanitised at parse time (`safeCount`); the Python ETL catches `OverflowError`.
- `/v1/queries`: executions are bound to the starting tenant (`QUERY#<tenant>/<id>`, TTL 24 h); polling another tenant's
  id → 404; template lookup uses own properties; `days` must be finite.
- `ui-qa-agent.yml`: `inputs` (read public CFN outputs) → `build` (PR code, `permissions: {}`) → `qa` (base-branch tooling
  deploys the artifact, runs the agents, patches the PR checkout under `pr/`); verdict = FAIL iff findings; `BLOCKING`
  also reddens; diff confined to one non-protected file; actions SHA-pinned; `deploy.yml` input validated and gated to
  `main` + `production` environment; dependabot on.
- CloudFront `ResponseHeadersPolicy` (HSTS, nosniff, DENY, referrer, Permissions-Policy, CSP report-only → enforce via
  config); Cognito client 1 h / 1 d tokens, no enumeration, no OAuth; pool threat protection + deletion protection + TOTP
  offered; SPA tokens in sessionStorage; `allowedOrigins` required outside dev/ci; Node.js 22 runtimes; aws-cdk-lib ≥ 2.260;
  DynamoDB TTL attribute + deletion protection; hidden source maps not uploaded.
- `infra/test/security.test.ts` asserts these as invariants; `ci-agent/test_agents.py` covers the verdict and diff rules.

## Non-goals (Phase 2 / 3)
Throttling and Athena bytes cutoff; registry field redaction and input caps; lifecycle/log retention/alarms; SDLC gate from
base; containment allow-list rewrite; Lake Formation settings (peer); tenant key by role (partition-key migration).
