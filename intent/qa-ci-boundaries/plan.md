# Plan: QA CI boundaries (feature-51)

- **Spec:** ./spec.md
- **Author:** Claude (AI agent)
- **Accepted-by:** Tim WU
- **Accepted-for:** 2928e2aba73e7c9dd1bd3eeebc51bdaa0e2165ce
- **Status:** shipped

`Accepted-for` is the tip of `main` after PR #122 (qa-persona-split). Nothing else is in flight on these files.

## Files changed
1. `ci-agent/qa_agent.py`, `ci-agent/test_agents.py`
2. CI: `.github/workflows/ui-qa-agent.yml`
3. Docs: `SECURITY.md`, `AGENTS.md` (rule 4), `CHANGELOG.md`, `docs/test-reports/feature-47-hardening-1-pipeline-and-isolation.md`
   (correction), `docs/test-reports/feature-51-qa-ci-boundaries.md` (new), `docs/test-reports/README.md`
4. SDLC: `intent/qa-ci-boundaries/intent.md`, `intent/qa-ci-boundaries/spec.md`, `intent/qa-ci-boundaries/plan.md`,
   `.sdlc/active` (handover from `qa-persona-split`), `intent/qa-persona-split/intent.md`, `intent/qa-persona-split/spec.md`,
   `intent/qa-persona-split/plan.md` (→ shipped; landed as #122)

## Order
issue → branch → push → PR → cancel the PR's own qa run before its `qa` job starts (it runs the base agent, which logs
in) → one `workflow_dispatch` of this branch with an off-list URL (refused before any agent call, so no login and no
spend) → owner sets `vars.QA_URL_ALLOWLIST` if more than the `TARGET_URL` origin is wanted → merge.

## Verification
`python3 -m unittest test_agents` on 3.12 and 3.14; mutation pass; workflow YAML parsed; SDLC gate against
`main@2928e2a`. Live per the spec.

## Risks
- **The PR's own qa run uses the base agent,** which has no allow-list and signs in. It is cancelled, as on #122.
- **A refusal is red.** A repo whose `TARGET_URL` is unset and `QA_URL_ALLOWLIST` empty now refuses every run instead of
  testing whatever URL it was given. That is the intended failure direction; the message names both variables.
- **The allow-list guards mistakes, not insiders.** A writer can still change this workflow, and with no `main` ruleset
  can push to `main` directly. SECURITY.md says so.
