# Plan: ci-dependabot-tamed (feature-48)

- **Spec:** ./spec.md
- **Author:** Claude (AI agent)
- **Accepted-by:** Tim WU
- **Accepted-for:** 74c13a8007c3774af8298236ad7e285e0bb8c727
- **Status:** shipped

`Accepted-for` is the tip of `main` after PR #84 (hardening-1). Urgent, small chain between hardening-1 and hardening-2;
the owner said "carry on" after the dependabot storm (2026-10-30).

## Files changed
1. `.github/dependabot.yml`
2. `.github/workflows/ui-qa-agent.yml`
3. `CHANGELOG.md`, `docs/test-reports/feature-48-ci-dependabot-tamed.md` (new), `docs/test-reports/README.md`
4. `intent/ci-dependabot-tamed/intent.md`, `intent/ci-dependabot-tamed/spec.md`, `intent/ci-dependabot-tamed/plan.md`,
   `.sdlc/active`, `intent/hardening-1-pipeline-and-isolation/intent.md`, `intent/hardening-1-pipeline-and-isolation/spec.md`,
   `intent/hardening-1-pipeline-and-isolation/plan.md` (→ shipped)

## Verification
actionlint; SDLC gate; leak scan. After merge: watch the next Monday run and the Actions list for dependabot branches.

## Risks
A grouped PR that fails CI blocks all minors for that ecosystem until someone looks — acceptable; the alternative was 22 PRs.
