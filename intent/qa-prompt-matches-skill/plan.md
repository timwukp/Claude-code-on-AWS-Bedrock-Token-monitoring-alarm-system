# Plan: QA prompt matches the skill (feature-52)

- **Spec:** ./spec.md
- **Author:** Claude (AI agent)
- **Accepted-by:** Tim WU
- **Accepted-for:** b774f3f85dc7784b936a30fbdae236fd074b4dfc
- **Status:** shipped

`Accepted-for` is the tip of `main` after PR #130 (qa-ci-boundaries). The QA session wrote these two files last and has
handed them over; it dropped its own PR for this change.

## Files changed
1. `ci-agent/qa_agent.py`, `ci-agent/test_agents.py`
2. Docs: `CHANGELOG.md`, `docs/test-reports/feature-52-qa-prompt-matches-skill.md` (new), `docs/test-reports/README.md`
3. SDLC:
   - `intent/qa-prompt-matches-skill/intent.md`, `intent/qa-prompt-matches-skill/spec.md`,
     `intent/qa-prompt-matches-skill/plan.md`
   - `.sdlc/active` (handover from `qa-ci-boundaries`)
   - `intent/qa-ci-boundaries/intent.md`, `intent/qa-ci-boundaries/spec.md`, `intent/qa-ci-boundaries/plan.md`
     (→ shipped; landed as #130)

## Order
1. Live run of this prompt from a local copy, in a slot from the main session.
2. The owner rotates the QA passwords.
3. Issue → branch → push (Git Data API) → PR.

The PR touches no path in `ui-qa-agent.yml`'s `paths` filter, so opening it starts no signed-in run.

## Verification
Unit and mutation checks per the spec; the SDLC gate against `main@b774f3f` with `--base-sha`; the live run per the
spec.

## Risks
- **The password still enters the model's context,** and so the invocation log and the session's Memory events. This
  change makes that explicit and single; it does not remove it.
- **A model that skips the skill now gets the right instruction from the prompt.** A model that ignores both still fails
  at sign-in, and the run reports that.
