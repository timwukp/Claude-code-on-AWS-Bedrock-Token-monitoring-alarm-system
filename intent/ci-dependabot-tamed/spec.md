# Spec: ci-dependabot-tamed

- **Intent:** ./intent.md
- **Author:** Claude (AI agent)
- **Accepted-by:** Tim WU
- **Status:** signed-off

## Behaviour
1. `.github/dependabot.yml` — six ecosystems (actions, npm ×3, pip, docker), `interval: weekly, day: monday`,
   `open-pull-requests-limit: 1`, one `groups` entry per ecosystem with `update-types: [minor, patch]`, and
   `ignore: dependency-name "*" / version-update:semver-major` on every ecosystem that has versions (docker excluded).
2. `.github/workflows/ui-qa-agent.yml` — `if: github.actor != 'dependabot[bot]'` on the `inputs`, `build` and `qa` jobs.

## Acceptance
- actionlint clean; the dependabot file validates (`version: 2`, known keys).
- After merge: the next dependabot run opens at most six PRs, none a major; no "UI QA Agent" run appears for a
  `dependabot/**` branch.

## Out of scope
Everything else.
