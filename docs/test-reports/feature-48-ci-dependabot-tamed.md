# Feature 48 — Dependency updates tamed

- **Chain:** `intent/ci-dependabot-tamed/` · **Branch:** `feat/ci-dependabot-tamed` off `main@74c13a8` (post-#84) · **PR:** #108
- **Origin:** feature-47's `dependabot.yml` opened 22 PRs in its first run (#86–#107), eleven majors; five UI-QA-agent
  runs for `dependabot/**` branches were in flight within the hour and were cancelled by hand (2026-10-30).
- **Verdict:** PASS on gates; behaviour verified on the next weekly run.

## What this report has to say plainly
- An ungrouped dependabot config on a repo with six ecosystems is a PR storm by construction, and because the QA workflow
  triggers on `frontend/**` / `backend/lambdas/api/**` paths, each frontend bump deployed its build to the shared dev
  site and invoked the harness. The storm cost CI minutes and harness invocations and risked leaving dev on a vite-8 build.
- Fix: grouped weekly minor/patch PRs, one per ecosystem, majors never auto-proposed; the QA pipeline's three jobs skip
  `dependabot[bot]` (dependabot PRs have no secrets anyway, so the `inputs` job could only fail).

## Scope
| File | Change |
|---|---|
| `.github/dependabot.yml` | groups + `ignore semver-major` + `open-pull-requests-limit: 1`, Monday |
| `.github/workflows/ui-qa-agent.yml` | `if: github.actor != 'dependabot[bot]'` on `inputs`, `build`, `qa` |

## Gates
| Gate | Result |
|---|---|
| actionlint | clean |
| SDLC gate | PASS — bound to `74c13a8` |
| Leak scan | clean |

## Owner actions recorded
Close the eleven major-bump PRs (#86, #87, #88, #89, #90, #91, #92, #100, #101, #104, #105); let CI judge the minors.
