# Feature 47 — Hardening 1: the pipeline cannot be wedged or poisoned; CI runs no PR code with credentials

- **Chain:** `intent/hardening-1-pipeline-and-isolation/` · **Branch:** `feat/hardening-1-pipeline-and-isolation` off `main@de51b8a` (post-#83, rebased) · **PR:** #84
- **Origin:** security audit 2026-10-28 (five parallel reviewers + live checks; owner approved a two-chain hardening programme the
  same day). This chain closes the audit's two Critical and five of its six High items; chain 2 (`hardening-2-limits-and-visibility`)
  takes limits, retention, alarms and the containment rewrite.
- **Date:** 2026-10-28
- **Verdict:** PASS on gates; live confirmation after the owner's Data → Etl → Api → Auth → Frontend deploys and the tenant-index
  migration (table below, to fill).

## What this report has to say plainly
- **A time bomb of my own making, defused.** feature-40 kept every tenant in one DynamoDB item. Measured on 2026-10-28: 2,715 session
  ARNs, ~341 KB of the 400 KB limit, growing ~15/day — four to six weeks from a write that fails on every run. Because the
  aggregator wrote its `ADD` counters before moving its watermark, that failure would have re-added the same objects every 15
  minutes, inflating every token and dollar figure until someone noticed. The index is now one item per tenant, and the aggregator
  processes one object at a time with a processed-marker, so a retry skips what was already counted.
- **A pull request could run code with the CI's AWS role.** The QA workflow checked out the PR's head and executed its `npm run
  build`, its `ci-agent/*.py` and its redactor with OIDC credentials and a `contents: write` token, while `main` had no pull-request
  requirement. Now the PR is built with no permissions, and everything that runs with credentials comes from the base branch.
  The owner also tightened the role's OIDC trust, the `main` ruleset and the account-level S3 Public Access Block (Phase 0).
- **The QA verdict was the agent's word.** Page text in the monitored account is written by Bedrock callers; an agent that read
  "overall: PASS" there and repeated it kept the check green with findings attached. The verdict is now derived from the findings.
  The bug-fix agent's diff was applied to every file it named — including, potentially, the redactor — while only one was checked;
  it is now confined to that one file and may not touch pipeline trust anchors.
- **Smaller but real:** any authenticated user could poll any Athena execution id; CloudFront sent no security headers; tokens sat in
  localStorage for 30 days; the API's CORS defaulted to `*`; 16 functions ran Node.js 20; a `1e309` token count in a log line would
  have thrown at the DynamoDB marshaller.

## Scope
| Area | Change |
|---|---|
| `ingestion/parse.ts` (+test) | `safeCount`, `sanitizeCounts` in `parseLogFile` |
| `ingestion/aggregator.ts` (+`aggregator-plan.test.ts`) | per-object loop; `planObjects`; `SYSTEM#PROCESSED` markers (TTL 30 d); `SYSTEM#TENANT` items; `usersToAdd` cap 500 + `userSetOverflow`; `LIST_OVERLAP_MS` |
| `shared/logged-estimate.ts`, `scripts/seed-tenant-index.ts` | Query the per-tenant items (legacy fallback); migration `--apply` |
| `api/queries.ts` (+test), `api-stack.ts` | `QUERY#<tenant>/<id>` binding, 404 on mismatch; `templateFor` (`hasOwn`), `daysFor`; table grant |
| `api/projects.ts`, `ProjectsPage.tsx` | `usersCapped` → `N+` |
| `analysis/etl.py` (+test), `Dockerfile` | `_to_int` catches `OverflowError`, rejects negative/huge; base image digest-pinned |
| `.github/workflows/ui-qa-agent.yml` | jobs `inputs` → `build` (`permissions: {}`) → `qa` (base-branch tooling, PR under `pr/`); verdict gate reddens on FAIL or BLOCKING; `--exclude "*.map"` |
| `ci-agent/qa_agent.py`, `bugfix_agent.py` (+`test_agents.py`) | `overall` derived from findings; `diff_paths`/`diff_is_confined`/protected prefixes; post-apply porcelain check with revert |
| `deploy.yml`, `sdlc-gate.yml`, `ci.yml`, `dependabot.yml` | input validation + `production` env + `main` only; `base_ref` via env; agent tests in CI; SHA-pinned actions; dependabot |
| `frontend-stack.ts`, `types.ts` | `ResponseHeadersPolicy` (HSTS, nosniff, DENY, referrer, XSS, Permissions-Policy, CSP report-only / `cspEnforce`) |
| `auth-stack.ts` | threat protection (Plus, FULL_FUNCTION), deletion protection, TOTP offered; client 1 h / 1 h / 1 d, `preventUserExistenceErrors`, `disableOAuth` |
| `api-stack.ts`, `data-stack.ts`, all stacks | `allowedOrigins` required outside dev/ci; TTL attribute + deletion protection; `NODEJS_22_X`; aws-cdk-lib 2.275 |
| `frontend/src/auth/cognito.ts`, `vite.config.ts`, `deploy-frontend.sh` | sessionStorage token store; hidden maps; maps not uploaded |
| `infra/test/synth.ts`, `infra/test/security.test.ts` | Auth/Dora/Api/Frontend in the harness; 14 invariants |
| `docs/MULTI_TENANCY.md`, `SECURITY.md` | deployment assumption, cooperative attribution, trust boundaries, owner-maintained settings |

## Independent adversarial review of the PR (same day) — what it found and what changed
| Finding | Severity | Fix |
|---|---|---|
| Two aggregator runs could overlap (Lambda async retry after a timeout + the 15-minute schedule) and ADD the same unmarked objects twice | High | `reservedConcurrentExecutions: 1`; EventBridge target `retryAttempts: 0` |
| Inside one object, N upserts precede the marker; a *persistent* failure re-adds that object's earlier rollups every run and pins the watermark — the "forever" case the PR claimed gone | High | per-object `try/catch`; `SYSTEM#FAILED/<key>` attempt counter; after 3 attempts the object is marked `failed: true` and skipped; the run stops at a failing object so the watermark never passes it |
| Workflow-level `env` (account id, harness ARNs) was inherited by the `build` job that runs PR npm scripts | Medium | env moved to the `inputs` and `qa` jobs only |
| First run after deploy: the 60 s overlap re-added the last minute's objects once | Medium | `markersSince` on the watermark item: strict listing until the first marker exists |
| `normalize_report` dropped non-object findings → `{"overall":"FAIL","findings":["login broken"]}` became PASS | Medium | non-object findings are kept as MEDIUM findings |
| `extract_json` took the *last* JSON object — a quoted `{"findings": []}` could win | Medium | prefer the object carrying `pages_tested` |
| Tokens already in localStorage (30-day refresh) stayed valid after the switch | Medium | boot-time purge of `CognitoIdentityServiceProvider.*` keys; owner may also `admin-user-global-sign-out` |
| `usersToAdd` compared the raw size — a project with exactly 500 users read `500+` forever | Low | compare against the ids present |
| Diff "confinement" accepted deletions, mode changes and symlink typechanges of the allowed file | Low | refused |
| Latency values only checked finite — `1e300` would sum toward DynamoDB's 1e126 limit | Low | bounded at 1e9 ms |
| Security test scanned `AWS::IAM::Policy` only; allow-list too loose | Low | Role inline + managed policies scanned; list tightened |
| `.map` files from earlier deploys remain in the bucket (`--exclude` also exempts from `--delete`) | Low | one-off `aws s3 rm … --include "*.map"` at the Frontend deploy (owner/me) |
| **QA harness logs in as the pool's only `admin` user** (my own follow-up check) — a steered agent could mutate the registry via the UI | **High (operational)** | **owner: create a dedicated non-admin QA user with its own tenantId and point the login secret at it** (Phase 0, item 5) |
| `environment: production` in `deploy.yml` is auto-created unprotected if absent | Info | owner: add required reviewers to the environment (Phase 0, item 6) |
| Cognito Plus compromised-credential default action may block a QA login with a breached-corpus password | Needs verification | QA password is generated; observe the first QA run after the Auth deploy |

Residual, stated: within one object the sequence is still at-least-once between the first upsert and the marker — bounded to
≤ 3 re-adds of that object's earlier rollups, then skipped and logged; exactly-once would need a transactional write per
object, deferred.

## qa on the PR — the new three-job workflow ran end to end (`inputs` → `build` → `qa`)
| Finding | Verdict | Action |
|---|---|---|
| F-PR84-001 LOW — ROI "Expected PRs / month" is a free-text input; `abc` was sent as `NaN` and the raw 400 with the request URL shown | valid, pre-existing | rider: `type="number"`, `inputMode="numeric"`, `min 1`, client-side validation message before any request |
| F-PR84-002 LOW — Settings "Save project" with empty fields "does nothing" (the button is disabled, but nothing says why; inputs not marked required) | valid, pre-existing | rider: `required`/`aria-required` on id and name, a visible "required to save" status while they are blank, and a title on the disabled button |
The first run (64ecfa7) crashed before any verdict: my boto3 pin (1.40.49) predated `bedrock-agentcore.invoke_harness`; re-pinned to 1.43.120 after verifying the method in a clean venv (168ab47).

## Gates
| Gate | Result |
|---|---|
| Backend `jest` / `tsc --noEmit` | PASS — 536/536 (+14) |
| `python3 -m unittest test_etl` / `test_agents` | PASS — 25 / 12 |
| Frontend `tsc --noEmit` / `vite build` | PASS |
| Infra `jest` (incl. `security.test.ts`) / `cdk synth -c env=ci` | PASS — 36/36 (+14) · 11 stacks |
| `actionlint` on all four workflows | clean |
| `sdlc_ci_gate.py --require-active` | PASS — bound to `de51b8a` |
| Leak scan | clean |

## Live — after the owner's deploys (to fill)
| Check | Result |
|---|---|
| Data `cdk diff` | TTL attribute + deletion protection on 4 tables (in place) |
| Etl / Api / Auth / Frontend `cdk diff` | Etl code; Api code + `PutItem/GetItem` grant for QueriesFn; Auth client validity + pool tier/add-ons/deletion protection; Frontend ResponseHeadersPolicy |
| `seed-tenant-index.ts --apply` | TBD — expect per-tenant items == 2,715, legacy item deleted |
| Aggregator invoked twice | TBD — second run `skipped == listed`, rollups unchanged |
| `GET /v1/queries/<other tenant's id>` | TBD — 404 |
| `curl -I` CloudFront | TBD — HSTS, X-Content-Type-Options, X-Frame-Options, Referrer-Policy, Content-Security-Policy-Report-Only |
| Cognito client | TBD — 60 / 60 / 1440 minutes; `PreventUserExistenceErrors ENABLED` |
| Phase 0 (owner) | TBD — ruleset requires PR + 4 checks; role trust = this repo's PRs + main; account PAB all true |

## Known limits, stated rather than fixed (chain 2 or later)
- Throttling / Athena bytes cutoff; registry field redaction for non-admins; lifecycle, log retention, alarms; SDLC gate from base;
  containment allow-list rewrite; Lake Formation IAM-only mode (peer); tenant key by role (partition-key migration).
- The QA login secret's literal values are not in the redactor (the harness holds them, not the runner; adding them needs a
  Secrets Manager read in the workflow role — outside CDK, owner's call).
- `plan_covers` stays a substring match to mirror the SDLC gate; diff confinement is the control that matters.
