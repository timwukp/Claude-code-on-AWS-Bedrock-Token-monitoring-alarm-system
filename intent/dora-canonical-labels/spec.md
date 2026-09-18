# Spec: canonical DORA labels on the delivery-performance surfaces

- **Intent:** ./intent.md
- **Author:** Claude (AI agent)
- **Accepted-by:** Tim WU
- **Status:** signed-off

## Behaviour

1. **Ordinal deployment-frequency band.** `deployFrequencyBand(perDay)` maps a measured rate onto
   DORA's six bucket strings, used verbatim so the label is citable:

   | Rate (merges per day) | Band |
   |---|---|
   | ≥ 2 | On demand (multiple deploys per day) |
   | ≥ 1 | Between once per hour and once per day |
   | ≥ 1/7 | Between once per day and once per week |
   | ≥ 1/30 | Between once per week and once per month |
   | ≥ 1/182 | Between once per month and once every six months |
   | > 0 | Less than once per six months |
   | no sample | `null` |

   The source leaves a rate of exactly 1.0/day on a seam between two buckets. It is assigned
   **upward**, and the top bucket is reserved for ≥ 2/day, which is what "multiple deploys per day"
   literally says. The rule is stated in the code and covered by a test rather than left implicit
   in a comparison operator.

2. **`band` travels with the value.** `DeploymentFrequency.band` is part of the metric object, so
   every surface that receives a deployment frequency receives its phrase: the per-repo metrics
   response, the cross-repo overview row, and the per-project Delivery × Cost row.

3. **No tier for change failure rate.** `tierFor('cfr', v)` returns `Unknown` for every input,
   including 0. `TIERS` no longer contains a `cfr` entry, and the type makes that structural
   (`Record<Exclude<MetricKey, 'cfr'>, …>`) so a future edit cannot quietly re-add thresholds.
   `CFR_BANDS_2024` exports the four published values **in report order**, non-monotonic as
   printed, for use as reference marks.

4. **Disclosure travels with the data.** The `dataSource` block on the metrics response states, in
   order: that DORA has five metrics and which one is absent; that deployment frequency is ordinal
   and how the 1/day seam is resolved; that the lead-time window shares DORA's start but not its
   end; that failure detection is title/label-based, so 0% means nothing matched the detectors;
   that the recovery-time metric is not DORA's failed deployment recovery time; that tier badges
   are the 2024 bands with DORA's own caveats; and that change failure rate has no band, with the
   four values quoted. `cfrReference` carries those values as data.

5. **Page presentation.**
   - The deployment-frequency tile headlines a short form of the band ("About weekly"), prints the
     verbatim DORA phrase, the merge count, the rate and the cohort split beneath it, and carries
     "deployment-frequency proxy" in its own label.
   - The lead-time tile label says "part of change lead time"; its footer says DORA's window ends
     in production.
   - The change-failure tile shows the percentage with a neutral accent, **no badge**, and a footer
     naming the non-monotonic values and why one metric cannot place a team.
   - The recovery-time tile says it is not DORA's failed deployment recovery time.
   - A fifth tile names deployment rework rate as not collected and identifies the missing signal.
   - Tier badges render as `<tier> (2024)` with DORA's caveat in the tooltip; `Unknown` renders as
     "no band", which is a statement about the sample rather than about performance.
   - The overview and project tables lead with the band, drop the change-failure badge, and carry
     the reference values in a caption.

6. **Unchanged.** Every computed value except the removed change-failure tier. No new endpoint, no
   new stored field, no infrastructure change.

## Out of scope

Renaming `mttr` (see the intent's non-goals), collecting rework rate, and switching change-failure
detection to incident records.

## Verification

Unit tests in `backend/lambdas/dora/dora-calc.test.ts` cover all six buckets, both sides of the
1/day seam, the no-sample path, the tier refusal at every change-failure value including 0, and the
published values in report order. `backend/lambdas/api/project-calc.test.ts` asserts the band
reaches the project row. `tsc`, the frontend build and `cdk synth` complete the gate set, and the
rendered page is checked against the live dev API.
