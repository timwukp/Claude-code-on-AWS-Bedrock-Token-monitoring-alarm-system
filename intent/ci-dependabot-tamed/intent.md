# Intent: dependency updates that do not storm the repo or the shared dev site

- **Slug:** ci-dependabot-tamed
- **Author:** Claude (AI agent)
- **Date:** 2026-10-30
- **Accepted-by:** Tim WU
- **Status:** accepted

## Problem
feature-47 added `.github/dependabot.yml` with per-ecosystem weekly updates and `open-pull-requests-limit: 5`, ungrouped.
Its first run opened **22 pull requests at once** (#86–#107), eleven of them major bumps (vite 5→8, TypeScript 5→7 twice,
pandas 2→3, pyarrow 16→26, @vitejs/plugin-react 4→6, React, four GitHub-actions majors). Every PR touching `frontend/**`
or `backend/lambdas/api/**` triggered the UI QA agent, which deploys the branch to the shared dev site and spends harness
minutes — five runs were in flight within the hour and had to be cancelled by hand.

## Desired outcome
- One grouped PR per ecosystem per week, minor and patch only; majors are never proposed automatically.
- The QA agent pipeline does not run for `dependabot[bot]` PRs (CI and the SDLC gate still do).

## Non-goals
Merging or closing the 22 existing PRs (owner's call: close the majors, let CI judge the minors); any other CI change.
