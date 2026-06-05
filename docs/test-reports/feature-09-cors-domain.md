# Test Report — Feature #9: Restrict CORS + custom domain + mapping-upload UX

| | |
|---|---|
| Issue | #9 |
| Branch | `feat/cors-domain-hardening` |
| Date | 2026-06-05 |
| Environment | Real AWS account, `us-east-1` |
| Result | **PASS** — unit + real-AWS end-to-end |

## Scope

Production hardening: lock API CORS to configured origin(s) instead of `*`; add optional custom
domain (ACM) support for the dashboard; provide a guided way to refresh the project-mapping CSV.

## Implementation

- `infra/lib/config/types.ts` — optional `api.allowedOrigins`. When set, API Gateway preflight
  uses those origins and the Lambdas echo a matching `Access-Control-Allow-Origin`; when
  omitted, falls back to `*` (demo convenience).
- `infra/lib/stacks/api-stack.ts` — `defaultCorsPreflightOptions.allowOrigins` driven by config;
  `ALLOWED_ORIGIN` env passed to the API Lambdas.
- `backend/lambdas/shared/response.ts` — response `Access-Control-Allow-Origin` reads
  `ALLOWED_ORIGIN` (defaults `*`); keeps preflight and actual-response headers consistent.
- `infra/lib/stacks/frontend-stack.ts` — optional custom domain: when `frontend.domainName` +
  `frontend.certificateArn` (ACM, us-east-1) are set, the distribution serves that domain.
- `scripts/upload-project-mapping.sh` — refresh the `project_mapping.csv` in the curated bucket;
  Athena reflects the update immediately (external table points at the prefix; no re-create).

## Unit tests

`cd backend && npm test` → **60 passed** (added 3 in `response.test.ts`): default origin `*`,
configured origin echoed, helper status codes.

## Build / synth gates

`tsc --noEmit` PASS; `cdk synth env=dev` and `env=ci` PASS.

## Real-AWS end-to-end validation

- Deployed `Tums-dev-Api` (dev has no `allowedOrigins` → permissive default preserved).
  - OPTIONS preflight from the CloudFront origin → `access-control-allow-origin: *`.
  - Authed `GET /v1/usage` → HTTP 200 with `access-control-allow-origin: *`.
- Production-lockdown path (temp config with `allowedOrigins:['https://dash.example.com']`)
  synthesized: API Lambdas get `ALLOWED_ORIGIN: https://dash.example.com` and the preflight is
  scoped to that origin (verified in the synthesized template).
- Custom-domain path: synth with `frontend.domainName` + `certificateArn` attaches the domain +
  ACM cert to the distribution (no live cert provisioned here — config-gated, off by default).

## Verdict

All gates green; default demo behavior preserved and validated live; production CORS lockdown +
custom-domain paths synthesize correctly; mapping refresh scripted. Ready for review.
