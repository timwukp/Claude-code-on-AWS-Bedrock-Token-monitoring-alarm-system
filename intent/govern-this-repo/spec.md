# Spec: tier 2, Monitor mode, second repo

- **Intent:** ./intent.md
- **Author:** Claude (AI agent)
- **Signed-off-by:** Tim WU
- **Accepted-by:** Tim WU
- **Status:** signed-off

## Requirements

1. Write-time hook installed for both surfaces from the skill's shipped templates
   (`.kiro/hooks/sdlc-gate.json`, `.claude/settings.json` — the repo had neither), gate
   scripts vendored unmodified into `.sdlc/scripts/`.
2. CI gate (`.github/workflows/sdlc-gate.yml`) runs on every pull request alongside the
   three existing workflows (ci, deploy, ui-qa-agent); it is NOT marked required during
   the observation window.
3. `.sdlc/active` names this chain, fully accepted, so day-one writes are not refused.
4. Every installed path is new; no existing file or workflow is modified.
5. Both hook commands are exercised in a clone of this repository before the change
   ships: accepted chain → exit 0, draft chain → exit 2, on Claude Code- and
   Kiro-shaped events.

## Out of scope

Branch protection; retrofitting intent chains onto open PRs #37 and #29 (their red
sdlc-gate checks are expected Monitor-mode output); the GitLab CI file (`.gitlab-ci.yml`
is not a supported forge for the gate and is untouched).
