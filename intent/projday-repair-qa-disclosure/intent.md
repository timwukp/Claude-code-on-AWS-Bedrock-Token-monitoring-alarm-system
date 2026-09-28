# Intent: repair one over-counted day, and stop qa filing what the page already explains

- **Slug:** projday-repair-qa-disclosure
- **Author:** Claude (AI agent)
- **Date:** 2026-09-28
- **Accepted-by:** Tim WU
- **Status:** shipped

## Problem 1 — the PROJDAY rollups for 2026-09-17 were over-counted

For the demo tenant, the daily PROJDAY items for 2026-09-17 carried +231 invocations, +12,380 input
and +146,311 output tokens more than the hourly USAGE rollups — and more than the raw logs, confirmed
independently by Athena `COUNT(DISTINCT requestId)` on #59 (7,786 invocations). Every other day
reconciled to the token. Since #57 moved the Cost page onto PROJDAY, the surplus appeared on screen as
a Usage-vs-Cost mismatch (qa F-PR61-001, HIGH). The shape is cross-run double processing on the
boundary day of feature-13's PROJDAY backfill.

The repair was run on 2026-09-24 under the owner's explicit authorisation and is verified (hourly ==
PROJDAY over 30 days, Δ 0/0/0). What this chain adds is the **script that did it**, so the method is
reviewable and re-runnable — it is guarded so a second run refuses.

## Problem 2 — qa files disclosed, quantified differences as findings

The UI QA agent has three times filed the `/projects` Full-vs-Fast gap as a finding
(F-PR59R3-002, F-PR61-002, F-PR61R2-001) while itself writing that the gap is *"consistent with the
disclosed 15-minute rollup lag and now explicitly quantified in the KPI subtitle"*. A difference the
page discloses and quantifies is the product working as designed. Under `QA_RED_ON: FAIL` that one
false positive reddens every PR, and the owner has decided — explicitly, twice — that the remedy is
**not** to lower the bar to `BLOCKING` (which would also silence the real LOW findings this policy
caught in the same week) but to teach the agent the distinction. This is a change to what qa reports,
and it is stated as such so it is approved knowingly.

## Non-goals
Re-deriving anything for other days (all reconcile); changing `QA_RED_ON`; any frontend change.
