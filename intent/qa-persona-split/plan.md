# Plan: QA personas (feature-50)

- **Spec:** ./spec.md
- **Author:** Claude (AI agent)
- **Accepted-by:** Tim WU
- **Accepted-for:** 7c06d3efe82fced66aa68c743bb6e4878f8fba8f
- **Status:** accepted

`Accepted-for` is the tip of `main` after PR #114 (lakehouse-p2-athena-workgroup). PR #115 also rewrites
`.sdlc/active`; whichever merges second rebases and re-binds `Accepted-for`. This chain does not touch the lakehouse
chains' files, so that one line is the only overlap.

## Files changed
1. `ci-agent/qa_agent.py`, `ci-agent/test_agents.py`
2. CI: `.github/workflows/ui-qa-agent.yml`
3. Docs: `AGENTS.md` (QA loop rule 4), `README.md` (QA section), `CHANGELOG.md`,
   `docs/test-reports/feature-50-qa-persona-split.md` (new), `docs/test-reports/README.md`
4. SDLC: `intent/qa-persona-split/intent.md`, `intent/qa-persona-split/spec.md`, `intent/qa-persona-split/plan.md`,
   `.sdlc/active`

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
