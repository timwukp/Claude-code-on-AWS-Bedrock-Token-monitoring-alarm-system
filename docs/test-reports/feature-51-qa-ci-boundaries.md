# Feature 51 — QA CI boundaries: say what the pipeline really protects; QA logins only on allowed origins

- **Chain:** `intent/qa-ci-boundaries/` · **Branch:** `fix/qa-ci-boundaries` off `main@2928e2a` (post-#122) · **Issue:** #129 · **PR:** #130
- **Origin:** review of the CI loop, 2026-11-27/28, after feature-50
- **Date:** 2026-11-28
- **Verdict:** PASS — unit checks, and a live refusal run with no login and no agent call.

## What this report has to say plainly
- **The documented boundary was stronger than the real one, in four places.** The workflow said a PR cannot change it for
  its own run, and that `main` needs a PR and checks. `SECURITY.md` and the feature-47 report said the owner applied
  "Phase 0". The live state, read on 2026-11-27:

  | Phase 0 setting | Live | Evidence |
  |---|---|---|
  | `main` ruleset: PR + `backend`/`frontend`/`infra`/`sdlc-gate`, no bypass | **Not applied** — only `deletion`, `non_fast_forward` | `GET /repos/…/rulesets/<id>/history`: 4 versions, 2026-06-05 → 2026-07-28, all with those two rules only; classic branch protection 404 |
  | OIDC trust: this repo's PRs + `main` | **Not applied** — `repo:<this repo>:*` and `repo:<Harness repo>:*` | `iam get-role`; CloudTrail: no `UpdateAssumeRolePolicy` / `PutRolePolicy` on the role in 90 days |
  | Account-level S3 Public Access Block on | **Not applied** — all four flags off | `s3control get-public-access-block` (the QA bucket has its own bucket-level block) |

  The first claim fails whatever Phase 0's status is: for `pull_request`, `GITHUB_SHA` is the PR's merge commit (GitHub's
  *Events that trigger workflows*), so the run uses the PR's own workflow file. What the base-branch checkout does stop
  is a PR changing `ci-agent/`, the redactor or the SDLC tooling for its own run.
- **The allow-list guards mistakes, not insiders.** Without a `main` ruleset, a writer can push to `main` directly. The
  manual run's free-text URL was the cheap way to send the QA logins somewhere wrong (a typo, the placeholder default,
  production), and that is what is now refused.

## Changes
| File | Change |
|---|---|
| `ci-agent/qa_agent.py` | `origin_of`, `allowed_origins`, `target_problem`, `refuse_target`; `--allowed-origins` (env `QA_URL_ALLOWLIST`, else `TARGET_URL`'s origin); checked before the harness client exists |
| `ci-agent/test_agents.py` | 11 new tests (43 total); the end-to-end harness passes `--allowed-origins` and controls `QA_URL_ALLOWLIST` / `TARGET_URL` |
| `.github/workflows/ui-qa-agent.yml` | trust-boundary and `contents: write` comments corrected; dispatch `url` optional, default empty; `QA_URL_ALLOWLIST: ${{ vars.QA_URL_ALLOWLIST }}` |
| `SECURITY.md`, feature-47 report, `AGENTS.md` | Phase 0 settings marked not applied with evidence; dated correction; rule 4 sentence |

## Unit checks (boto3 stubbed)
| Check | Result |
|---|---|
| `python3 -m unittest test_agents` on Python 3.12 and 3.14 | 43 / 43 PASS |
| Mutation pass over the new guards (scheme, default port, bad port, fallback only when empty, fail-closed, admin-page origin, the check in `main`, refusal exit code / verdict / blocking flag, `TARGET_URL` fallback) | 12 / 12 killed. A 13th mutant (dropping `.lower()` on the host) survived because `urlparse` already lowercases `hostname`; the redundant call was removed |
| PR #122's 24 mutants | still 24 / 24 killed |
| Workflow YAML parse; SDLC gate against `main@2928e2a` | PASS |

## Live verification
**`workflow_dispatch` 46087982767, 2026-11-28 00:27Z, commit `faf7be4`, `url` = `https://qa-allowlist-refusal.invalid/`**
(a reserved TLD, so even a failed guard could not have reached a real host). `QA_URL_ALLOWLIST` is unset, so the allowed
origin was the `TARGET_URL` origin.

| Check | Result |
|---|---|
| Refused before any harness call | ✅ `::error::UI QA refused to start: target URL 'https://qa-allowlist-refusal.invalid/' is not on an allowed origin (…)`; the QA step ran 1 s (a real run takes minutes) |
| No agent session, no login | ✅ 0 occurrences each of the session banner, `===== viewer pass`, `===== admin pass`, `stream failed` |
| Nothing published to S3 | ✅ 0 `published report to` lines |
| Check colour | ✅ red: the QA step exits 2, **Fail check if the QA report is not clean** reports UNKNOWN; **Fail check if a QA pass broke the safety rules** passes (no `readonly`/`persona` outputs to judge) |
| No Bug-Fix stage | ✅ skipped (dispatch, and `blocking=false`) |

The run's deploy step re-synced this branch's frontend to the dev site first; PR #130 changes no frontend code, so it is
the build that was already live. The PR's own `pull_request` run (46087909716, base-branch agent, which signs in) was
cancelled before its `qa` job ran any step.

## Still open (owner)
Phase 0 — the three settings above. Applying the ruleset with the four checks (not `qa`, which every run reddens while
the app's findings stay open) would make the corrected comment's "this token could also push to main" false again;
update it then.
