# Intent: make the CI QA loop's check colour tell the truth, and keep its bot inside the plan

- **Slug:** qa-loop-honesty
- **Author:** Claude (AI agent)
- **Date:** 2026-09-21
- **Accepted-by:** Tim WU
- **Status:** accepted

## Problem

This repository ships an agentic CI loop: a UI QA agent explores the deployed dev site on every
frontend PR and writes a structured report; a Bug-Fix agent root-causes the blocking findings against
the repo source, patches, and pushes onto the branch, re-triggering the loop. It works — it has
found and fixed real defects across a dozen PRs.

Three failures in its governance have now each happened more than once, and all three are failures
of the same kind: **the loop reports something other than what it found.**

### 1. A failing report can end the run green

`ci-agent/qa_agent.py` exits non-zero when blocking findings remain, but its workflow step carries
`continue-on-error: true` — deliberately, because a non-zero exit there must not abort the fix loop
before the Bug-Fix stage, the PR comment, the stall detector and the round fuse have run. Nothing
downstream ever read the verdict back. `overall` was computed and written into `qa-report.json`, but
only `blocking`, `progress`, `fixed` and `findings` reached `$GITHUB_OUTPUT`.

The workflow's only red paths are "two consecutive zero-progress rounds" and "the absolute round
fuse blew". That leaves a hole with a precise shape: **blocking findings remain, the stall counter is
below 2, and the bot pushed no patch.** Nothing is pushed, so the workflow is not re-triggered, so
the stall counter never advances to 2, so the run ends green and stays green.

PRs #51, #52 and #53 each reached "all checks passed" while their own report said `overall: FAIL`.
On #53 that was six green checks next to a report naming five live findings. A green check is the
signal a reviewer acts on; a green check over a FAIL report is worse than no check at all, because
it actively asserts something untrue.

### 2. The bot patches files the gate will reject

`.sdlc/scripts/sdlc_ci_gate.py` requires every changed product source file to be named in the active
intent plan. The Bug-Fix agent had no such restraint: it located a likely source file by filename
score and patched it. When that file was outside the active plan, the auto-fix commit turned the
`sdlc-gate` check red — so a patch meant to green one check reddened another. This happened on #48
(`ProjectsPage.tsx`) and #51 (`dora.ts`); each needed a hand-written revert commit to undo.

The staging step had the same defect from the other direction: `git add -- backend frontend infra`
staged anything dirty in the runner tree, not just what the agent had patched.

### 3. A finding nobody's plan covers recurs forever

Consequence of (2), once (2) is enforced: a finding whose file no active plan names is refused every
round, on every PR, without anyone deciding not to fix it. One `/anomalies` copy defect was reported
**four times** — F-PR51-006 → F-PR52-001 → F-PR53-003 → F-PR53-103 — purely for want of a plan that
happened to name the file. The loop was working correctly and the defect was going nowhere.

### 4. Two pages state a count in a way that invites a wrong sum

Found while triaging #53's report, and the same class of problem at the page level:

- `/projects` — with the Full (Athena) source selected, "Projects tracked" counts the Athena rows
  while "Total tokens" and "Total est. cost" stay on the per-model rollups. Three tiles, two
  sources, no label: a reader sees 5 projects beside totals that cover 21 of them.
- `/latency` — the two fleet tiles report "N streaming invocations" and "M invocations" without
  saying the first set is *contained in* the second. That omission is exactly the arithmetic the QA
  agent itself got wrong when it invented F-PR53-001 by adding the two sample counts together.

## Why now

(1) is live on every open PR, and the fix is small and well-scoped. (2) and (3) are one decision
about what the bot is allowed to do. (4) is the same honesty rule applied to the pages, and both
files are otherwise untouched by in-flight work.

## Non-goals

- Making the QA agent find fewer things, or lowering any severity to get a green check.
- Changing the loop's convergence logic: the stall detector and the round fuse keep their jobs.
- Teaching the Bug-Fix agent to amend plans. It refuses and says so; a human opens the chain.
