# Intent: say what the DORA page actually measures, in DORA's own words

- **Slug:** dora-canonical-labels
- **Author:** Claude (AI agent)
- **Date:** 2026-09-18
- **Accepted-by:** Tim WU
- **Status:** accepted

## Problem

The DORA page computes four metrics correctly and then describes them in a way a professional
reader can reasonably mistake for something stronger than what was measured. A research pass over
DORA's own primary sources (`docs/research-dora-presentation.md`, 14 claims confirmed by adversarial
verification) found five specific mismatches, each of which is a labelling defect rather than a
maths defect:

1. **A merge is presented as a deployment.** DORA anchors every metric on a deployment that reaches
   production, and its own reference implementation warns that deriving deployment metrics from
   merge events skews them. Our page carries that caveat in a footnote, below the number a
   headline-only reader takes away.
2. **Deployment frequency is shown as a decimal rate.** Every DORA instrument states this metric as
   one of six ordinal phrases ("between once per day and once per week"). "0.14/day" is the
   intermediate arithmetic, not the finding, and it is the form a non-expert misreads.
3. **A tier is derived from change failure rate alone.** The published 2024 values are
   non-monotonic across the levels — Elite 5%, High 20%, Medium 10%, Low 40% — because the levels
   are clusters over the whole metric vector. No threshold ordering can reproduce them, so a
   per-metric badge on that metric is not attributable to DORA.
4. **Tier badges are undated.** The 2025 report replaced the four levels with seven team
   archetypes, so an unqualified "Elite" badge asserts a framework that has since moved.
5. **The page says four metrics.** DORA has had five since 2024. Deployment rework rate needs a
   signal we do not collect, and omitting it silently costs more credibility with a reader who
   knows the framework than naming the gap would.

The common thread is the one this portal keeps relearning: the defect is in what a surface
*discloses about itself*, not in what it computes.

## Desired outcome

- Deployment frequency reads as DORA's ordinal band first, with the rate as supporting detail.
- The word "proxy" sits in the label of every merge-derived number, not in a footnote.
- Change failure rate carries no tier, and shows the four published values as reference marks
  instead, with the reason stated where the number is.
- Every tier badge is dated to the 2024 report and carries DORA's own caveat that the levels are
  annual survey benchmarks applied per application, not grades.
- The fifth metric is named as not collected, with the missing signal identified.
- The recovery-time metric keeps a name that matches its own scope rather than borrowing DORA's
  renamed one.

## Acceptance

Owner-directed. The owner asked how DORA should be expressed so that a professional customer
reads it correctly ("關於dora 的表述…怎樣表示才合理"), which produced the research pass. This
intent applies its recommendations to the shipped page. Merging the feature PR is the recorded
confirmation.

## Non-goals

No new data source and no change to any computed value except the removal of a tier that was
never derivable. In particular, this does **not** switch change failure rate to incident records:
the research does not support that as an upgrade, and it would trade a known false-negative mode
for a worse one on teams that do not file incidents. Renaming the recovery-time metric to DORA's
"failed deployment recovery time" is also deliberately excluded, because that 2023 change narrowed
the metric's *scope* to change-caused impairments and ours still counts incident issues with no
deployment linkage. A rename over an unchanged definition would be worse than the old label.
