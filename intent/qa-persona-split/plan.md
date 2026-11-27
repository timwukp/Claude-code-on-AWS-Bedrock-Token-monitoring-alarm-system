# Plan: QA personas (feature-50)

- **Spec:** ./spec.md
- **Author:** Claude (AI agent)
- **Accepted-by:** Tim WU
- **Accepted-for:** 2ab3abf267dc0a5293ab4beb2f3cd7d3377b007f
- **Status:** accepted

`Accepted-for` is the tip of `main` after PRs #115–#120 merged (2026-11-27 14:04–14:07Z). The branch was cut from
`7c06d3e` (post-#114) and approved there; #115 merged first and rewrote `.sdlc/active` and `CHANGELOG.md`, so `main` was
merged into the branch (both changelog entries kept) and the owner re-confirmed the plan against this base.

## Files changed
1. `ci-agent/qa_agent.py`, `ci-agent/test_agents.py`
2. CI: `.github/workflows/ui-qa-agent.yml`
3. Docs: `AGENTS.md` (QA loop rule 4), `README.md` (QA section), `CHANGELOG.md`,
   `docs/test-reports/feature-50-qa-persona-split.md` (new), `docs/test-reports/README.md`
4. SDLC: `intent/qa-persona-split/intent.md`, `intent/qa-persona-split/spec.md`, `intent/qa-persona-split/plan.md`,
   `.sdlc/active` (handover from `lakehouse-p2-workgroup-encryption`), `intent/lakehouse-p2-workgroup-encryption/intent.md`,
   `intent/lakehouse-p2-workgroup-encryption/spec.md`, `intent/lakehouse-p2-workgroup-encryption/plan.md` (→ shipped; landed as #115)

## Order
Owner creates the non-admin user and its secret, rotates the admin password (commands in the test report) → issue →
branch → push → PR → cancel the PR's own qa run before its `qa` job starts (it runs the base agent) → one
`workflow_dispatch` run of this branch (the live test) → live checks → test report → owner merges.

## Verification
`python3 -m unittest test_agents` on 3.12 and 3.14; mutation pass over the new guards; workflow YAML parsed; the comment
script rendered with a two-pass and an old-style report; the safety step's shell run for each output value; SDLC gate.
Live per the spec.

## Risks
- **The PR's own qa run uses the base agent.** `ui-qa-agent.yml` takes `ci-agent/` from the base branch, so until this
  merges, a PR run is the old prompt. Passing `--secret-id` explicitly makes even that run the non-admin; it may file
  Settings' access notice as a finding, which the Bug-Fix agent cannot patch (no active plan names the page).
- **Selectors are not semantics.** A write control with an unhelpful selector (`#btn-3`) passes the viewer audit; the
  server's 403 is the viewer's real protection. The admin pass is held to a positive list instead, so an unknown click
  there is a violation.
- **The stream may not carry every tool call.** A pass whose stream shows no browser action reports `unobserved`
  (warning), not `ok`; the live run checks that the audit sees the actions.
- **One more harness session per run.** The admin pass reads one page: minutes, and one more session's tokens.
