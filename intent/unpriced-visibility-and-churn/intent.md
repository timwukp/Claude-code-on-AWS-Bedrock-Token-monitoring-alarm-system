# Intent: unpriced usage is visible, cache churn is measurable, and the bill panel reads as one thing

- **Slug:** unpriced-visibility-and-churn
- **Author:** Claude (AI agent)
- **Date:** 2026-10-23
- **Accepted-by:** Tim WU
- **Status:** shipped

## Problem

Chain B of the LLM-gateway study (plan `floating-enchanting-kahan`, approved 2026-10-14). Feature-40 (#73) put the bill
beside the logged estimate and feature-41 (#74) made unknown models report themselves instead of pricing at $0. What a
reader still cannot do:

1. **See how much caching is churn.** Cache writes are 60 %+ of spend; a project whose writes are never re-read (a router
   switching models mid-conversation, sessions shorter than the 5-minute TTL) looks identical to a healthy one. No page shows
   writes as a share of cache traffic per project.
2. **Trust the drift check for the new rows.** `check-rate-card.ts` only knew Claude under the Marketplace price list; GPT-6
   Astra and gpt-oss ARE in AWS price lists (Marketplace and first-party respectively) but were not compared; Nova Micro
   was reported "not in list" for the same reason; models genuinely absent (the five card-sourced OpenAI rows, gated Mythos)
   had no recorded source, so an absence could not be told from an omission.
3. **Read one bill panel.** #73 and the frontend half of this chain each shipped a bill-vs-logged panel on Cost with
   different columns and framing; the Overview tile and the help text still described Mantle dollars as an estimate.
4. Three qa leftovers from #73 on pages this chain owns: an unknown URL silently showed the Overview; the Projects
   "Projects tracked" caption described table rows while the Athena scan was still running; DORA strings did not
   pluralise.

## Desired outcome

- "Cache churn" (writes ÷ (reads + writes)) per project on By project and on Overview's "What changed", with a help entry
  that says what a rising share means; null shown as "—" when a project has no cache traffic.
- One bill panel on Cost ("Account bill vs all tenants' logged estimate") with the account-scope framing, this tenant's
  logged estimate, `billedZero`, `overEstimated`, Mantle counts and the logged share; the Overview Spend tile names the
  unlogged total; help explains the subtraction and why Mantle tokens are never multiplied by a rate.
- Unpriced models: the "unpriced" badge on Cost rows and a warn chip on the Overview Spend tile beside the existing
  `UnpricedNote`; help entry `cost.unpriced`.
- `check-rate-card.ts` compares every card row that AWS publishes (Claude + GPT-6 Astra from the Marketplace list; Nova
  Micro + gpt-oss from the first-party list), allow-lists the rest with a source and date, and fails on any other absence.
- A not-found page for unknown URLs; the Projects caption waits for the scan; DORA counts pluralise.
- Incident record: the "$0 bill / payer account" diagnosis corrected to the service-name mistake #73 found.

## Non-goals

- Per-session cache churn (no session id in the invocation log).
- Any pricing or rollup change (features 36–41 own those); any change to the peer's `UnpricedNote` component or the
  `/latency` page.
