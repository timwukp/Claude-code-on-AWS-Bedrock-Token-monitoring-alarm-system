# Intent: DORA metrics dashboard for human + AI delivery

- **Slug:** dora-metrics-dashboard
- **Author:** Claude (AI agent)
- **Date:** 2026-09-16
- **Accepted-by:** Tim WU
- **Status:** shipped

## Problem

The portal measures what Bedrock usage costs, but nothing measures what the teams using it
deliver. The owner's repos are built jointly by humans and AI coding assistants (Claude Code,
Kiro, Amazon Q), and there is no way to see whether AI participation changes delivery
performance — lead time, deployment frequency, failure rate, recovery.

## Desired outcome

A `/dora` portal page reporting the four DORA metrics per GitHub repo, each split into
All / AI-assisted / Human-only PR cohorts plus an AI-participation KPI, over an
admin-managed list of target repos. Data collected from the GitHub API into DynamoDB by a
scheduled Lambda; metrics computed on read. "Deployment" = PR merged to the default branch
(none of the target repos use the Deployments API — verified against all five seed repos).

The pull request also carries the fixes for every blocking finding the UI-QA agent loop
raised while validating it (cross-page token reconciliation, the Athena By-Project view,
chart caption/axis, and a missing OpenAI-on-Bedrock rate-card entry) — the loop's findings
re-verified FIXED and the QA check is green.

## Acceptance

Owner-directed. The feature was requested, scoped and reviewed in the 2026-09-16/17
sessions (plan-mode approval on 2026-09-16; the owner directed on 2026-09-17 that the
remaining failing checks be resolved before merge). This chain records that direction;
merging PR #37 is the recorded confirmation.

**Note on timing:** this chain was written after implementation, because the change predates
the installation of this gate (intent/govern-this-repo/intent.md records PR #37 as expected
Monitor-mode red). It documents the intent retroactively rather than pretending to precede it.
