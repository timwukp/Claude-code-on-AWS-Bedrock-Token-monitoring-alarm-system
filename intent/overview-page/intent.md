# Intent: land on an overview, not on a raw chart

- **Slug:** overview-page
- **Author:** Claude (AI agent)
- **Date:** 2026-09-18
- **Accepted-by:** Tim WU
- **Status:** shipped

## Problem

The portal opens on the Usage page — a token chart. Nothing on the first screen answers the three
questions every reader arrives with: how much are we spending and is that more or less than before, is
it under control, and did anything change. The 2026-09-18 audit (`docs/research-dashboard-ux.md`,
defect 1) ranked this the highest-impact structural defect.

## Evidence

Research finding R1 (3-0, four primary sources): AWS's own cost-management landing, Vantage's
Overview, Cloudscape's service-dashboard pattern and IBM Carbon's dashboard guidance all open on a
small set of headline KPIs followed by "what changed", and defer raw exploration to linked pages;
Cloudscape says the dashboard "should be the first link listed" in the side navigation. R2 (3-0): a
KPI carries a delta against a **named** comparison period, a status, and a link to its detail page.

What the existing API could not supply: spend for a window *and* the equal-length period before it.
`/v1/costs` is all-time only. The daily per-project × model rollup (PROJDAY) already exists and is
priced by the same rate card as the Cost page, so one additive endpoint over it gives a period delta,
a daily series and per-project movers that reconcile with Cost and Projects by construction.

## Desired outcome

- `/` is an Overview with four tiles — **Spend** (window total, delta vs the prior equal period with
  the compared dates named, sparkline), **Budget** (month-to-date billed vs limit, status), **Anomalies**
  (count in window, critical called out), **Deployment frequency** (median across synced repositories)
  — each with an ⓘ and a link to its page, and a **What changed** table of the projects whose spend
  moved most. Overview is the first nav item; Usage moves to `/usage`.
- One new read-only endpoint, `GET /v1/overview?window=`, plus two **additive** booleans on
  `/v1/governance` (`billingDataAvailable`, `forecastAvailable`) so the UI can tell "no billing data on
  this account" from a real $0. No existing field changes shape.
- When per-project rollups begin inside the prior period, the page says the comparison is against a
  partial baseline instead of showing a clean delta.

## Non-goals

- No change to any existing number; the Cost and Projects pages are untouched (their windowed views
  are the next chain's).
- No forecast of our own: the only forecast shown is AWS Budgets'.
- Movers compare like with like (prior equal period); no week-over-week special case.
