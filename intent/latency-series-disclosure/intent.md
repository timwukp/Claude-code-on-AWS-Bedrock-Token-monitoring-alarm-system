# Intent: say on /latency that the fleet and per-model figures are separate series

- **Slug:** latency-series-disclosure
- **Author:** Claude (AI agent)
- **Date:** 2026-09-28
- **Accepted-by:** Tim WU
- **Status:** accepted

## Problem
qa on #63 filed F-PR63-001 (LOW): the `/latency` by-model rows summed to 4,336 invocations while the fleet
tile said 4,187 for the same 7-day window, and suspected profile-routed calls counted twice. Checked at
CloudWatch: fleet `SampleCount` 4,240 == Σ per-`ModelId` 4,240 — no double count (same as the
2026-09-18 check). The gap qa saw is that the fleet series and the per-model series are published
separately by CloudWatch, so for minutes after a burst one can lead the other. The page did not say so.
Under the #62 rule a *disclosed* difference is not a finding; an undisclosed one is. This makes it disclosed.

## Non-goals
Changing any number or query; hiding the gap; touching the per-project section.
