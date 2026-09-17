# Intent: attribute Bedrock cost to projects and join it with DORA

- **Slug:** project-cost-attribution
- **Author:** Claude (AI agent)
- **Date:** 2026-09-17
- **Accepted-by:** Tim WU
- **Status:** shipped

## Problem

99.7% of the portal's tracked tokens (210.98M of 211.59M) sit under `untagged`: voluntary
requestMetadata tagging cannot cover IDE-agent traffic (Claude Code has no way to send it, and
AWS provides no IAM key to require it — verified twice, including an adversarial deep-research
pass, 25/25 claims confirmed). Meanwhile the DORA page answers "how well does each repo
deliver" and the By-Project page answers "which project burns which tokens", but the two views
do not join: the owner cannot see what a project's delivery performance costs.

## Desired outcome

- Bedrock usage attributable to a PROJECT (one or more GitHub repos) with zero per-call
  developer effort, via per-project tagged application inference profiles (log `modelId`
  records the profile ARN) with identity hints as fallback and requestMetadata as the optional
  finer grain.
- Cost answerable over the same 7/30/90-day windows DORA uses (daily rollups + one-off
  historical backfill).
- A "Projects — delivery × cost" panel on the DORA page: pooled DORA metrics per project plus
  tokens, est. USD and $/deployment; project registry (name, cost center, repos, identity
  hints) managed by admins on the By-Project page.
- Opt-in IAM enforcement making tagged profiles the only invokable path, with a pilot role to
  validate the deny/allow matrix.

## Acceptance

Owner-directed: research reviewed 2026-09-16 (deep-research verification pass explicitly
requested), plan-mode design approved 2026-09-17 with four recorded decisions (daily rollups;
DORA-page panel; repo Claude Code settings for attribution; opt-in IAM enforcement construct).
Merging the feature PR is the recorded confirmation.

Full research record: docs/research-project-cost-dora-attribution.md.
