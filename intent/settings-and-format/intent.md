# Intent: administration leaves the monitoring pages

- **Slug:** settings-and-format
- **Author:** Claude (AI agent)
- **Date:** 2026-09-21
- **Accepted-by:** Tim WU
- **Status:** accepted

## Problem

The By project and DORA pages each end in an admin form: the project registry (22 rows × Edit/Remove)
and the tracked-repository list (add / sync / remove). A reader who came to check spend or delivery
scrolls past red `Remove` buttons for records they cannot touch; an administrator has to remember which
monitoring page hides which form. The 2026-09-18 audit (`docs/research-dashboard-ux.md`, defect 9)
listed this as one of the reasons the two longest pages felt unprofessional: monitoring and
administration share a scroll.

A small formatting leftover rides with it: the Invocations KPI on Usage was the one figure still
formatted with an unpinned `toLocaleString()`, so a browser in another locale would print it
differently from every other number on the page (the same class of defect qa raised as F-1102).

## Evidence

Research finding R3 (3-0): limit what a view carries; defer what does not aid interpretation. Table
standard 9: row actions leave monitoring tables. Both admin forms depend only on `isAdmin` and two
registry endpoints, so they move without changing behaviour.

## Desired outcome

- A `/settings` route (footer nav item) with two panels — **Projects** and **Tracked repositories
  (DORA)** — lifted from their pages with identical fields, validations and confirmations; non-admins see
  an explicit "Administrator access required" state with a way back.
- By project and DORA lose their admin panels and gain a one-line pointer to Settings for admins.
- `fmtInt` pins en-US grouping for plain counts; Usage's Invocations uses it.

## Non-goals

- No change to `fmtTokens` (the other session's T-tier version on main is the reference).
- No change to registry or DORA APIs.
- ROI assumptions overrides stay on the ROI detail panel: they are per-project analysis inputs, not
  platform administration.
