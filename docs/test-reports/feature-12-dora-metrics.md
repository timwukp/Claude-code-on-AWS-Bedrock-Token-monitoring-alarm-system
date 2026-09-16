# Feature 12 — DORA metrics dashboard (human + AI-assisted delivery)

| | |
|---|---|
| **Issue** | — |
| **Branch / PR** | `feat/dora-metrics` |
| **Date** | 2026-09-16 |
| **Environment** | `dev` (us-east-1) — live stacks + live API + live CloudFront site |
| **Result** | **PASS** — including real-data validation after the operator set the PAT |

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

## Real-data validation (2026-09-16, after the operator set the PAT)

Full backfill (180 days, 6 repos) completed in one collector run: all repos `ok`, no rate
limiting. Collected counts match a direct GitHub survey exactly (53 / 25+1 incident / 14+6 /
1 / 24 / 2 — the workshop repo's second PR predates the backfill window).

90-day window spot checks (all consistent with known repo history):

| Repo | PRs | AI % | Deploy freq | Lead time | CFR | MTTR |
|---|---|---|---|---|---|---|
| agent-skills-best-practice | 38 | 34.2 (10 Claude Code, 3 Kiro) | 0.42/d **High** | 1.6 h **Elite** | 0% **Elite** | Unknown |
| the monitoring repo itself | 10 | 100 (Claude Code) | 0.11/d **Medium** | 0.3 h **Elite** | 30% **Low** | 0.3 h **Elite** |
| kiro-banking-best-practices | 1 | 100 | 0.01/d **Low** | 0.4 h **Elite** | 0% **Elite** | Unknown |
| dora-metrics-platform, workshop, kiro-sdlc | 0 in window | — | Unknown tiers render cleanly | | | |

Cross-checks: the monitoring repo's CFR = 2 reverts (the ABAC reverts, PRs #35/#36) + 1 incident
issue over 10 merges — exactly right; its MTTR comes from that one closed incident. AI/Human
cohort splits, per-assistant counts, recent-PR attribution (e.g. #68 claude-code, #67 kiro) and
the weekly timeline all line up. Window filtering verified: dora-metrics-platform has 14 PRs in
the 180-day store but 0 in the 90-day window (last push 2026-06-02).

## Operator steps (one-time, after merge)

All done in dev (PAT set via console 2026-09-16; demo user in the `admin` group). For a fresh
environment: put a fine-grained read-only (public repos) PAT into the
`token-monitor-demo/github-token` secret, add admins to the Cognito `admin` group, then Sync now.

## Verdict

**PASS.** All gates green; every API path and UI state validated against the real dev
environment, first with the placeholder token (instructional "not configured" states) and then
with real data after the operator supplied the PAT: full 6-repo backfill, counts matching a
direct GitHub survey, correct AI/Human splits, tiers, CFR components and window filtering.
