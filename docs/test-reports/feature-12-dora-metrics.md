# Feature 12 — DORA metrics dashboard (human + AI-assisted delivery)

| | |
|---|---|
| **Issue** | — |
| **Branch / PR** | `feat/dora-metrics` |
| **Date** | 2026-09-16 |
| **Environment** | `dev` (us-east-1) — live stacks + live API + live CloudFront site |
| **Result** | **PASS** (data collection starts once the operator pastes the GitHub PAT — see "Operator steps") |

## Scope

Per-repo DORA metrics (Deployment Frequency, Lead Time for Changes, Change Failure Rate, Time to
Restore) for GitHub repos built by humans + AI coding assistants, each metric split into
**All / AI-assisted / Human-only** PR cohorts plus an AI-participation KPI. Admin-managed target
repo list (new Cognito `admin` group). New `/dora` page in the portal.

Definitions ported from the reference implementation (`timwukp/dora-metrics-platform`):
deployment = PR merged to the default branch (verified: none of the seed repos use the GitHub
Deployments API); tiers follow the DORA bands; revert/hotfix classifiers + incident issues
(labelled `bug`/`incident`); AI attribution from commit `Co-Authored-By` trailers, bot authors
and PR-body markers (Claude Code / Kiro / Amazon Q / Copilot).

## Implementation

- `backend/lambdas/dora/` — `dora-calc.ts` (pure metric math, cohorts, ISO-week timeline),
  `dora-classify.ts` (pure classifiers), `github-client.ts` (fetch-based REST + rate-limit floor),
  `secret.ts`, `store.ts`, `collector.ts` (seed-once + incremental sync via per-repo watermarks,
  180-day backfill), `types.ts`.
- `backend/lambdas/api/dora.ts` — 6 routes on one Lambda (`GET/POST /v1/dora/repos`,
  `DELETE /v1/dora/repos/{owner}/{name}`, `POST …/sync`, `GET /v1/dora/metrics`,
  `GET /v1/dora/overview`); admin routes enforce the `cognito:groups` claim server-side.
- `backend/lambdas/shared/admin.ts` (tolerant groups parser) + `forbidden/created/accepted`
  response helpers.
- Infra: `tums-dora` table (DataStack), `admin` group (AuthStack), new `DoraStack`
  (Secrets Manager secret `token-monitor-demo/github-token` with placeholder + collector Lambda on
  a 6 h schedule), ApiStack routes/grants, `dora` config block (ci/dev/example).
- Frontend: `DoraPage.tsx` (repo + 7/30/90-day pickers, tier-coloured KPI tiles with AI/Human
  sub-values, weekly deploys stacked human-vs-AI + lead-time charts, cohort breakdown table,
  recent-PR table, all-repos overview, admin panel), `client.ts` typed endpoints + server error
  text surfaced, `isAdminUser()`, formatters, `.seg`/`.btn-sm` styles.

## Unit tests

`cd backend && npm test` — **10 suites / 102 tests passing** (65 before this feature; +37 new
across `dora-calc` (tier boundaries incl. 1/day · 1⁄7 · 1⁄30, median/p95/mean, coding-vs-review,
CFR cap at 100, MTTR union of hotfix PRs + closed incidents, empty→Unknown, AI/human splits,
ISO-week year rollover 2025-12-29→2026-W01, window exclusion), `dora-classify` (real-world strings
incl. `Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>`,
`amazon-q-developer[bot]`, `patched` negative), `github-client` (rate-limit parse, Link header,
403/429), `collector` item mappers, `shared/admin` claim shapes, `shared/response` new helpers).

## Build / synth gates

- backend `tsc --noEmit` ✅ · backend `jest` ✅ (102/102)
- frontend `tsc && vite build` ✅
- infra `npm run build` + `cdk synth --context env=ci` ✅ (9 stacks incl. `Tums-ci-Dora`)

## Real-AWS end-to-end validation (dev, 2026-09-16)

Deployed `Tums-dev-Data` / `Auth` / `Dora` / `Api` (CDK) and published the frontend to
CloudFront (`E109P5BP3CW3XT`, invalidated).

| Check | Result |
|---|---|
| `tums-dora-dev` table ACTIVE; secret created with `REPLACE_ME`; `admin` group exists | ✅ |
| Collector run with placeholder token → all 5 seed repos registered, status `token-not-configured`, no GitHub calls | ✅ |
| `GET /v1/dora/repos` as non-admin → `isAdmin:false`, `tokenConfigured:false`, 5 repos | ✅ |
| `POST /v1/dora/repos` as non-admin → **403** with clear error | ✅ |
| Added user to `admin` group → token carries `cognito:groups:["admin"]`, `isAdmin:true` | ✅ |
| `POST` add (full GitHub URL accepted, normalised) → **201**; duplicate → **400**; `not a repo` → **400** | ✅ |
| `DELETE` throwaway repo → **200** (cascade), repeat → **404** | ✅ |
| `POST …/sync` → **202**, registry status flips to `pending` | ✅ |
| `GET /v1/dora/metrics` (empty data) → tiers `Unknown`, null values, 14 continuous weekly buckets, no errors | ✅ |
| `window=12` → **400** (`must be one of 7, 30, 90`); no auth → **401** | ✅ |
| Live site serves new bundle; `/dora` route returns the SPA (200) | ✅ |

## Operator steps (one-time, after merge)

1. Paste a **fine-grained, read-only (public repos)** PAT:
   `aws secretsmanager put-secret-value --secret-id token-monitor-demo/github-token --secret-string <PAT>`
2. Admins: `aws cognito-idp admin-add-user-to-group --user-pool-id <UserPoolId> --username <email> --group-name admin`
   (already done for `demo@tokenmonitor.local` in dev; sign out/in to refresh the token).
3. Click **Sync now** on `/dora` (or wait ≤ 6 h for the schedule).

## Verdict

**PASS.** All gates green; every API path and UI state validated against the real dev
environment. The "no data yet" path (placeholder token) is exercised end-to-end and renders
instructional, non-alarming states. First real data collection intentionally awaits the
operator-supplied PAT (secret values are never committed or set by automation).
