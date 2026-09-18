# Intent: make the DORA page dense enough to read, without deleting what it discloses

- **Slug:** dora-copy-density
- **Author:** Claude (AI agent)
- **Date:** 2026-09-18
- **Accepted-by:** Tim WU
- **Status:** accepted

## Problem

The previous chain (`dora-canonical-labels`, shipped as #42) made this page **factually** correct:
it named the merge count a proxy, refused a change-failure tier that no threshold ordering can
reproduce, and added the fifth metric as *not collected*. It achieved that by stacking every
caveat onto the tile face, and the result does not read like a professional instrument:

1. **Three competing headlines for one fact.** The deployment-frequency tile carries a
   question-form label ("How often do changes reach main?"), an invented short band ("About
   weekly") and DORA's verbatim ordinal phrase — for a single measured rate.
2. **One caption line merges four categories** under a single `·` separator: DORA's wording, the
   sample, the derived rate, the 2024 band, and the cohort split. A reader cannot tell which of
   those is a measurement and which is a definition.
3. **Definitional constants re-render on every load.** The proof that the 2024 change-fail-rate
   values are non-monotonic (Elite 5% · High 20% · Medium 10% · Low 40%) is a property of DORA's
   report, not of this tenant's data, yet it occupies the same visual weight as the measurement.
4. **Question-form labels force the metric name back in as a parenthetical** —
   "(deployment-frequency proxy)", "(part of change lead time)" — so the tile is longer *and* the
   canonical name is demoted to a suffix.
5. **The AI tile both overclaims and reads casually.** "How much did AI help write it?" promises a
   code-authorship measurement. What the pipeline counts is pull requests carrying an AI
   co-author trailer.

## What the evidence adds — and where it contradicts us

`docs/research-dora-card-copy.md` (8 findings, each with a 3-vote adversarial tally and source
URLs) was gathered for this chain. Two of its findings change our code rather than only our copy:

- **DORA's spelling is "Change fail rate"** — zero occurrences of "change failure rate" anywhere in
  DORA's own live instrument. Our `changeFailureRate` identifier is off-spec.
- **Do not headline an ordinal band** (3-0, high confidence). **This overturns a decision #42
  shipped.** DORA's own live instrument reports a continuous 0–10 score against an industry mean
  ± standard deviation; `Elite`/`High`/`Medium`/`Low` appear zero times as labels in it, and the
  September 2025 report replaced the levels with clusters. Dating the badge "(2024)" was right;
  promoting it to the headline was not.

The defensible substitute for a band is a percentile against the benchmark distribution — which we
do not have. So no benchmark appears on the tile face at all, and the drawer says why. That is the
same refusal this product already applies to every number it cannot support.

One boundary the evidence draws around itself: **three of the five research angles produced no
usable evidence.** There is no established finding that long caveat text harms comprehension, no
confirmed vendor pattern for disclosing proxy measurement, and no DORA-sanctioned term for
AI-authored share. Terseness here is therefore a **design judgement about scanability and buyer
credibility — not a research finding**, and neither this chain nor its test report may present it
as one.

## Desired outcome

- One tile states one measurement: a canonical noun label, at most one qualifier chip, one number,
  and one line of sample provenance.
- Nothing that was disclosed is deleted. Every caveat string removed from a tile face is findable
  in a single "Definitions & limitations" disclosure on the same page.
- That disclosure is openable by keyboard and touch, not by hover, because a caveat reachable only
  by mouse-over is not a disclosure.
- Coverage state — "not collected", an empty sample — stays **on the card face**, where it is a
  finding about this tenant's data rather than a definition.
- The metrics are grouped under DORA's own umbrella ("software delivery performance") as
  **Throughput** and **Stability**, with recovery time on the stability side.
- The AI metric leaves the DORA grid, because keeping it among the five implies a sanction that
  does not exist, and is renamed to what the pipeline actually counts.
- The payload field spells the metric DORA's way.

## Non-goals

- No change to any computed value. This chain moves, renames and deletes copy; the arithmetic in
  `dora-calc.ts` is untouched apart from an identifier rename and one new exported reference table.
- No new data source. Deployment rework rate stays *not collected*; recovery time keeps its own
  narrower scope and DORA's renamed term is still refused for it.
- No benchmark, percentile or archetype name on any tile.
