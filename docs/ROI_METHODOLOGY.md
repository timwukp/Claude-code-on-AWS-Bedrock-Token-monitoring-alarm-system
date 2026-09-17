# AI-coding ROI methodology

This page documents exactly how the portal's **ROI** page computes its numbers, what evidence
each element rests on, and what the page deliberately refuses to compute. It exists so the
numbers survive scrutiny from AI-skeptical reviewers. Research record with full citations and
adversarial verification: `docs/research-roi-model.md`.

## The model (DORA provenance)

The skeleton is DORA's published first-year AI ROI model (dora.dev/ai/roi), whose formulas we
verified verbatim against the calculator's own source code:

```
ROI      = (Value − Investment) / Investment        Payback = Investment / annual Value
Value    = time-saved + throughput + stability delta (SIGNED)
Investment = actual AI spend (annualized) + training + J-curve (one-time)
```

| Term | Formula | Source of the numbers |
|---|---|---|
| Time saved | teamSize × loadedCostPerYear × netTimeSaved% | assumptions (floor **−100%**: the verification tax can exceed the savings — DORA's own input allows negative) |
| Throughput | Δfeatures/yr × ideaSuccessRate (0.33) × revenueImpactPerFeature (0.01–1%) × revenueBase | Δfeatures **measured** (deployments vs baseline); the conventions are DORA's published conservative defaults — this *is* the Forrester-style risk adjustment |
| Stability delta | baseline(deploys/yr × CFR × MTTR × $/hr) − current(...) | CFR/MTTR/deployments **measured** (DORA store); **signed** — DORA's own defaults assume CFR can WORSEN under AI, so this is a cost line whenever stability regressed |
| AI spend | daily per-project rollups × per-model rate card, × 365/window | **measured** (enforceable inference-profile attribution) — replaces the calculator's guessed "additional AI cost" |
| Training / J-curve | trainingCostPerUser × teamSize; teamSize × salary × drop% × months/12 | assumptions (DORA defaults 15% for 3 months); **one-time, never annualized** |

Windows are 30/90 days only — annualizing a 7-day window is statistically indefensible.

## The break-even view (lead metric)

`break-even hours/month = monthly AI spend ÷ (loadedCostPerYear / 2080)` → % of team capacity.
Two inputs, zero revenue guesses. The verdict compares the required saving against the honest
experimental bracket below; "within bracket" means *plausible*, never *proven*.

## The evidence bracket (why no multiplier is hard-coded)

| Study | Design | Result | Caveats |
|---|---|---|---|
| Peng et al. 2023 (arXiv 2302.06590) | RCT, ~95 freelancers, one greenfield task | **+55.8%** | single well-specified task; vendor-affiliated authors |
| Google 2024 (arXiv 2410.12944) | RCT, 96 FTE engineers, enterprise task | **~+21%** | wide CI (p=.038); vendor evaluating its own tool |
| METR 2025 (arXiv 2507.09089) | RCT, 16 experienced OSS maintainers | **−19%** | early-2025 tools; explicitly not generalized |

The spread is the finding: context dominates. The page displays **−19%…+56%** and resolves the
number per project from that project's own telemetry and your own evidence.

**Perception is disqualified as an input.** In METR's RCT, developers forecast +24%, were
measured −19%, and afterwards still believed +20%. Nothing on the ROI page accepts a survey.

**Portfolio logic.** DORA 2025's headline finding: AI is an *amplifier* of an organization's
existing strengths and weaknesses, not a uniform multiplier. Identical spend diverges across
projects — hence per-project unit economics and the kill-fast portfolio view, never one blended
company-wide multiplier.

## What the page refuses to compute (and why)

- **Revenue attribution to the coding assistant** beyond DORA's disclosed conventions —
  DORA itself calls it "very difficult to project".
- **Survey-based time savings** — see the METR perception gap above.
- **A single cross-project productivity multiplier** — contradicts the amplifier finding.
- **Causal AI-vs-human deltas from observational PR cohorts** — AI-assisted PRs are not a random
  task sample (selection bias). The cohort views on the DORA page are labeled observational; the
  published causal path is a lightweight holdout (randomly assign AI access, compare telemetry).
- Terms whose inputs are missing (no revenue base, no stability baseline, <4 weeks of history)
  are **refused with an on-page note**, never invented.

Three refusals guard the composite percentage itself. In each case the components, the measured
spend and the break-even threshold are still shown — only the headline is withheld:

- **A window with no shipped output** (no merged PRs and no deployments). Spend is measured, but
  every surviving value term is then assumption-only with nothing in the telemetry anchoring it,
  so a percentage would read as a finding when it is arithmetic on defaults.
- **A project with no staffing of its own.** The value side scales with `teamSize ×
  loadedCostPerYear`, which is a property of the team that actually worked on *that* project.
  Falling back to a shared default claims one team's annual saving once per project, so a
  portfolio of twenty projects reports twenty times a placeholder. Set per-project staffing and
  the composite appears.
- **Spend below one engineer-hour per month.** As investment approaches zero the ratio explodes:
  a few dollars of spend against a fixed labor assumption yields four- and five-digit
  percentages. The floor is expressed in the model's own units rather than as a magic constant.

## Refuted claims we will not cite

Adversarial verification (3-vote) killed these commonly quoted numbers — they do not appear
anywhere in this product:

- GitHub/Accenture headline effects (+8.69% PRs, +15% merge rate, +84% builds).
- "The 2024 DORA report proves AI increases individual productivity."
- "The 2024 DORA report proves AI harms delivery throughput/stability." (We use only the DORA
  ROI calculator's own instability-aware defaults.)

## Disclosed heuristics (no published validation yet — rules stated, flagged on-page)

- **Kill-fast signal**: "review recommended" after 2 CONSECUTIVE weeks with spend > P90 and
  merged PRs < P25 of the *prior* weeks (out-of-sample; ≥4 weeks history required). A signal for
  a human conversation — never an automated gate or approval workflow.
- **Forward budgeting**: reference-class bands (P25/P50/P90 of weekly $ and $/merged-PR) from a
  chosen existing project's own history × expected PRs/month. A band, not a promise; refused
  below 4 weeks of history.
- **Runaway-spend guard**: any single request whose estimated cost exceeds a configured absolute
  threshold (default $50) is flagged onto the Anomalies feed with its model, project and cost —
  judging "justified long task vs runaway loop" stays a human call, now with the data in front
  of them.
- **Spend value classification**: optional project `category` (product / chore / experiment) +
  a "no shipped output in window" flag; separates chore-type consumption without per-call
  ceremony.

## Framing

Per DORA's own methodology note, every output on the ROI page is a **high-uncertainty estimate
meant to spark a conversation** — component breakdowns with editable assumptions, not a single
triumphant number.
