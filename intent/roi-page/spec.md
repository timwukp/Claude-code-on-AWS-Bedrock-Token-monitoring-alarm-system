# Spec: AI-coding ROI page (feature-14)

- **Intent:** ./intent.md
- **Author:** Claude (AI agent)
- **Accepted-by:** Tim WU
- **Status:** signed-off

## Behaviour

1. **Model.** The skeleton is the published DORA first-year AI ROI model, whose formulas were
   verified against the calculator's own source:

   ```
   ROI = (Value − Investment) / Investment       Payback = Investment / annual Value
   Value      = timeSaved + throughput + stabilityDelta      (stabilityDelta is SIGNED)
   Investment = measured AI spend (annualized) + training + J-curve (one-time)
   ```

   - `timeSaved = teamSize × loadedCostPerYear × netTimeSavedPct`, floor **−100%** — the
     verification tax can exceed the saving, and the source calculator allows a negative input.
   - `throughput = Δdeployments/yr × ideaSuccessRate (0.33) × revenueImpactPerFeature
     (0.0001–0.01) × revenueBase`; `revenueBase = 0` ⇒ the term is **refused**, not zero-filled.
   - `stabilityDelta = baseline(deploys × CFR × MTTR × $/hr) − current(...)`, **signed**, so a
     stability regression is reported as a cost.
   - `aiSpend` comes from the measured per-project daily rollups priced with the shared rate
     card — it replaces the calculator's guessed "additional AI cost".
   - `training` and `jCurve` are **one-time and never annualized**.

2. **Windows** are 30 or 90 days only. A 7-day window is rejected with an explanatory 400:
   annualizing one week is statistically indefensible. The annualization factor (365/window) is
   disclosed in the response and on the page.

3. **Stability baseline** resolution order: explicit configured baseline → split the window in
   halves (each half needs ≥3 deployments) → **omit the term with a stated refusal**. Refusing
   beats inventing.

4. **Break-even** (the lead view): `hoursPerMonth = monthlySpend ÷ (loadedCostPerYear / 2080)`,
   `pctOfCapacity = hours ÷ (teamSize × 173.3)`. Verdict is `within-rct-bracket`,
   `above-rct-bracket`, or `unknown` when labor cost is unset. "Within bracket" means
   *plausible*, never *proven*, and the page says so.

5. **Assumptions** are an optional `roi` object on a registry project, validated server-side
   (`teamSize` 1–10000 integer, `loadedCostPerYear` 1000–5e6, `netTimeSavedPct` −100–200,
   `revenueImpactPerFeature` 0.0001–0.01, `category` ∈ product|chore|experiment, `jCurve`,
   `baseline`). Precedence **project ▷ org defaults ▷ code defaults**, and the effective source
   is disclosed per project. Org defaults live at `REGISTRY#META/roi-defaults` behind
   `GET/PUT /v1/projects/registry/defaults` (PUT admin-only).

6. **Endpoints** on a new read-only Lambda:
   - `GET /v1/roi/projects?window=30|90` — per project: ROI components, break-even, unit
     economics, reference bands, kill-fast flag, refusals; plus org defaults, `isAdmin` and a
     `methodology` block that carries the refusal list and the evidence bracket.
   - `GET /v1/roi/estimate?reference=<projectId>&prsPerMonth=<n>[&teamSize&loadedCostPerYear]` —
     forward budget band and projected break-even from the reference project's own 90-day
     history. Readable by any signed-in user; only assumption **edits** are admin-gated.

7. **Kill-fast signal** (disclosed heuristic, no published validation): flagged after 2
   **consecutive** weeks whose spend exceeds P90 and whose merged PRs fall below P25 **of the
   prior weeks only** (out-of-sample; ≥4 weeks of history required). A signal for a human
   conversation, never a gate.

8. **Runaway-spend guard**: any single invocation whose estimated cost exceeds a configured
   absolute threshold (default $50, `0` disables) is written to the existing Anomalies feed with
   its model, project and cost. The threshold boundary is exclusive. The anomaly key is
   deterministic, so re-processing a log object is idempotent.

9. **Page order** is deliberate: methodology banner → break-even strip → per-project component
   waterfalls with signed bars and an assumptions drawer → portfolio scatter (kill-fast) →
   forward estimator → a closing note that the AI-vs-human cohort views are **observational**,
   with the causal alternative named (a randomised holdout).

## Non-goals

Revenue attribution to the assistant beyond the source calculator's disclosed conventions;
survey- or perception-based inputs; one cross-project productivity multiplier; causal claims
from observational PR cohorts; any automated spend control. Terms whose inputs are missing are
refused on-page, never invented.

## Generic-product constraint (owner-directed)

No customer name, brief, or identifying figure may appear in any committed artifact, page copy,
commit message or PR body — the requirement is described as a class ("enterprises at $1M+/yr
assistant spend"). This is enforced by a pre-push scan alongside the account-id scan.

## Evals / verification

Pure-module Jest on `roi-calc.ts` (17 cases): annualization applied to rate-like terms but not
one-time costs; honest negative ROI; stability-as-cost; the −100% floor; the revenue-impact
clamp; a zero-delivery window; `Investment = 0` yielding `null` rather than a division blow-up;
missing baseline producing a refusal; J-curve excluded; break-even arithmetic against a hand
fixture; `revenueBase = 0` refusal; percentile bands over an 8-week array and `null` under 4
weeks; kill-fast firing only on consecutive out-of-sample weeks; and weekly bucketing across a
month boundary with per-model pricing. Plus registry `validateRoiConfig` cases and
`detectRunaways` threshold/pricing cases. Live verification recorded in
`docs/test-reports/feature-14-roi-page.md`.
