# Intent: every figure reconciles with the one beside it

- **Slug:** numbers-reconcile
- **Author:** Claude (AI agent)
- **Date:** 2026-09-30
- **Accepted-by:** Tim WU
- **Status:** shipped

## Problem

qa on #65 and #66 raised six findings where two figures on the portal sit next to each other, disagree, and nothing
on the page says by how much or why:

1. **/roi** (F-PR65R3-001, F-PR66-002): monthly spend used a 30.44-day month while the annual figure used 365/window,
   and the page showed the factor rounded to 12.17, so monthly × 12 did not reproduce the annual figure.
2. **/latency By model** (F-PR66-003): the Lambda kept the first 12 series in ListMetrics order and dropped the rest
   without saying so, which let a busy series lose its row to an idle one. The #64 disclosure blamed "a burst" for the
   column not summing to the fleet total. The real cause was the silent cut.
3. **/latency** (Latency 1c): per-project latency exists only in the Fast (DynamoDB) rollups and the page did not say
   so. Separately, the rate card had no rows for the Claude 5.x point releases, so `sonnet-5-5`, `sonnet-5`, `opus-5-5`,
   `fable-5-1` and `mythos-5-1` were priced at their family rates.
4. **/latency fleet tiles** (F-PR66-004, HIGH): CloudWatch counts every caller in the AWS account while the Usage page
   counts this tenant's logged calls, so the two invocation counts differ and nothing beside the tiles quantifies it.
5. **/dora banner** (F-PR66-005): "N PRs collected" reads as this window's count. It is every merged PR stored since
   collection began. The stored count matches a live count for all six repositories, so the fix is the label.
6. **/projects** (F-PR66R2-001): Full "can run slightly ahead of" Fast with no number, while the measured gap was
   $7.67.

## Desired outcome

Each pair either agrees by construction or the page states the difference as a number beside the figures, with its
cause. No figure is suppressed.

## Non-goals

- No Athena latency (the Glue table maps no response body). The page states Fast-only instead.
- No cache-write pricing (the card has never priced cache writes, and this chain does not add them).
- No change to the `/costs` id counting. That is the next chain (`cost-id-consistency`).
