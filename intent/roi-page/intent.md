# Intent: prove — or disprove — the ROI of AI coding from measured data

- **Slug:** roi-page
- **Author:** Claude (AI agent)
- **Date:** 2026-09-17
- **Accepted-by:** Tim WU
- **Status:** accepted

## Problem

Enterprises running AI coding assistants at scale ($1M+/yr of assistant spend, hundreds of
seats) are asked by their own finance and engineering leadership to justify that spend, and
they cannot. The evidence they reach for is the wrong shape:

- **Vendor and survey numbers.** Self-reported time savings are known to be wrong in the
  direction that flatters the tool: in a randomised trial, experienced maintainers forecast
  +24%, measured **−19%**, and afterwards still believed +20%.
- **A single company-wide multiplier.** The published research finds AI *amplifies* an
  organisation's existing strengths and weaknesses rather than multiplying output uniformly, so
  one blended number hides the projects that are losing money.
- **Nothing that ties dollars to delivery.** Spend lives in a billing console, delivery lives
  in a DORA dashboard, and headcount cost lives in a spreadsheet. Nobody joins them.

This portal is now the rare place where two of the three are already **measured facts** rather
than estimates: feature-13 made Bedrock spend attributable per project through enforceable
tagged inference profiles, and feature-12 computes per-repo DORA metrics with AI-assisted and
human-only cohorts. Only the labor-cost assumption is missing, and that one the customer owns.

A second, sharper problem sits alongside the first: a single runaway agent loop can burn
thousands of dollars in hours, and today nothing in the portal notices a single expensive
request.

## Desired outcome

- A **ROI** sub-page that computes, per project, the return on AI-coding spend from that
  project's own measured cost and delivery telemetry plus disclosed, editable labor
  assumptions — and that states plainly which terms it **refuses** to compute.
- A **break-even** view that leads the page and needs only two inputs (monthly spend, loaded
  labor cost), so a reviewer who rejects every revenue assumption still gets a usable number:
  how many engineer-hours per month the assistant must save to pay for itself.
- Honest uncertainty: the experimental bracket for AI coding speed is displayed as a range
  (**−19% to +56%**), never collapsed into a hard-coded multiplier, and never sourced from a
  survey.
- **Forward budgeting**: for a project that does not exist yet, a reference-class band (P25 /
  P50 / P90) drawn from a comparable existing project's own history, presented as a band and
  refused outright when history is too short.
- **Kill-fast**: a portfolio view that shows which concurrent AI bets are diverging, plus a
  runaway-spend signal on the existing Anomalies feed. Both are signals for a human
  conversation, explicitly never automated gates or approval workflows.

## Acceptance

Owner-directed. Research pass requested and reviewed 2026-09-17 (`docs/research-roi-model.md`,
25 claims adversarially verified, 22 confirmed 3-0, **3 refuted and therefore excluded from the
product**). Plan-mode design approved 2026-09-17 with the explicit instruction that the model be
"科學性的，嚴謹的，說服力" — scientific, rigorous, persuasive — and a second explicit
instruction that **no customer name or identifying information appear in any artifact**, because
this is generic product software. Merging the feature PR is the recorded confirmation.

## Non-goals

Approval bureaucracy of any kind: no per-request budget gates, no spend pre-authorisation, no
automated shut-off. The owner's requirement is evidence for a conversation, not a control plane.
