# Spec: latency series disclosure

- **Intent:** ./intent.md
- **Author:** Claude (AI agent)
- **Accepted-by:** Tim WU
- **Status:** shipped

## Behaviour
The "By model" panel description on `/latency` states: the rows and the fleet tiles are separate CloudWatch
series; for a few minutes after a burst the per-model rows can run ahead of the fleet total (or vice
versa), so their sum need not equal it at any instant; the fleet series is the reference; profile-routed
calls are not counted twice and the two agree once both have caught up. Copy only.

## Out of scope
Everything else on the page.
