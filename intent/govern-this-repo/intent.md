# Intent: govern this repository with the ai-native-sdlc gate

- **Slug:** govern-this-repo
- **Author:** Claude (AI agent)
- **Date:** 2026-09-22
- **Status:** draft

## Problem

The owner is dogfooding his ai-native-sdlc skill (second governed repository, after
timwukp/llmops-agentic-system#146). This repository is a fuller-stack project — backend,
frontend, infra, a CI agent, 114 tracked files — with three existing workflows and two
open pull requests, and no committed artifact chain governing changes.

Two facts are recorded rather than glossed:

1. **114 files sits beyond the skill's verified envelope** ("the largest governed
   exercise is a few dozen files" — COMPATIBILITY.md). Governing it is deliberate: the
   first data point at this scale is dogfood value, and any misbehaviour is a finding
   against the skill, not against this repository.
2. **The two open pull requests (#37, #29) predate the gate** and carry no intent chain.
   Once the gate workflow is on main, their sdlc-gate check will show red. That is
   Monitor-mode data, not breakage — the check is not required and does not block them.

## Desired outcome

Same tier-2 Monitor mode as the first repository: write-time hook on both surfaces
(fail-open), CI gate on every pull request but NOT a required check, this chain accepted
so the Build gate is open on day one. The observation window is shared with the first
repository (~2-4 weeks); the promotion decision is made per-repo from each repo's own
refusal record.

## Acceptance

Owner-directed (2026-09-22 session: "can also apply into the repo of
Claude-code-on-AWS-Bedrock-Token-monitoring-alarm-system"). Merging the installation PR
is the recorded confirmation.
