# Intent: name the model behind an inference profile, or say we cannot

- **Slug:** latency-profile-labels
- **Author:** Claude (AI agent)
- **Date:** 2026-09-18
- **Accepted-by:** Tim WU
- **Status:** accepted

## Problem

Feature-18 (#52) shipped `/latency` with a by-model table built directly off CloudWatch's `ModelId`
dimension. That dimension does not always hold a model id. When a request is routed through an
**application inference profile** — which is the mechanism this product's own cost attribution
depends on — CloudWatch reports the series under the profile's id: an opaque twelve-character
string such as `c5xf7omvk87g`.

So the table shipped rows whose name told the reader nothing. The UI qa agent flagged it on #52 as
F-PR52-002 (LOW): *"By-model latency table shows raw inference-profile IDs instead of resolved model
names."* Three of ten rows on the dev account were affected, two of them among the highest-volume
series in the window.

This is worse than cosmetic on this particular page. The whole argument of `/latency` is that a
number is only shown when it can be attributed — hops that cannot be measured are drawn without
numbers on purpose. A row labelled with an unidentifiable id is the same failure in the other
direction: a real number attributed to nothing the reader can act on.

## Why it is fixable

`bedrock:ListInferenceProfiles` returns, for every application inference profile, its id, its name
and the foundation models it routes to. The mapping from the CloudWatch dimension back to a model is
therefore available at request time from the authoritative source, with no new data store, no
backfill and no change to what is ingested.

Verified on the dev account before this chain was written: all three ids qa flagged resolve to a
single distinct model each.

## What this does not do

It does not invent a name when the evidence is absent, and there are two such cases:

1. **A profile that routes to more than one distinct foundation model** cannot be attributed to any
   one of them, because the latency in that row is a mixture. Picking the first would be a
   fabrication, so the row keeps the profile's own name and no model is claimed.
2. **A profile that cannot be found** — deleted since the metrics were published, or the list call
   denied or failed — keeps the raw id. The raw id is at least literally what CloudWatch reported.

It also does not extend scope: still fleet-wide, still no project dimension, still no per-hop
numbers on the dark hops. Per-project latency remains phase 1b as recorded in the feature-18 plan.

## Outcome

Every row in the by-model table either names the model whose latency it reports, or visibly declines
to — and which of the two it is, is a field in the API response rather than a guess in the page.

Relates to: `intent/latency-observability/` (#52, the feature this corrects) and
`intent/athena-attribution-parity/` (#44, where the same profile-id-to-project resolution problem
was solved for cost).
