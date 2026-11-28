# Intent: QA CI boundaries — say what the pipeline really protects, and keep the QA logins on allowed origins

- **Slug:** qa-ci-boundaries
- **Author:** Claude (AI agent)
- **Date:** 2026-11-28
- **Accepted-by:** Tim WU
- **Status:** accepted

## Problem
Two documented security boundaries of the QA loop were not true, and one input had no limit.
- `ui-qa-agent.yml` says "A PR can therefore not change this workflow … for its own run". For `pull_request`, GitHub runs
  the workflow from the PR's merge commit, so a same-repo PR does change it for its own run.
- The workflow, `SECURITY.md` and the feature-47 report say `main` is ruleset-protected (PR + checks required) and that the
  owner applied "Phase 0" (that ruleset, an OIDC trust limited to this repo's PRs and `main`, the account-level S3 Public
  Access Block). None of the three is in effect: every ruleset version blocks only deletion and force-push, the trust
  accepts any ref of two repositories, and the account-level block is off. A reader, and one triage of an issue, relied
  on the false boundary.
- A manual run's `url` is free text, and the agent types the QA logins into whatever page it names. The input's default
  is a placeholder (`https://your-app.example.com/`).

## Desired outcome
- The workflow comments, `SECURITY.md` and the feature-47 report state the boundary and the Phase 0 settings as they are,
  and name Phase 0 as an open owner action.
- `qa_agent.py` refuses, before any harness call, a target whose origin is not allowed (`QA_URL_ALLOWLIST`, else the
  origin of `TARGET_URL`), and admin pages off the target's origin. A refusal is red (UNKNOWN), starts no Bug-Fix stage
  and leaves the S3 prior report alone. The dispatch input is optional and defaults to `TARGET_URL`.

## Non-goals
- Applying Phase 0 (repository and account settings are the owner's).
- Narrowing the OIDC role's permissions (separate item, owner-applied).
- The prompt's code-interpreter instruction (after the allowedTools PR in the Harness repo).
- The Ops Console's own Run QA path (owned by another session).
