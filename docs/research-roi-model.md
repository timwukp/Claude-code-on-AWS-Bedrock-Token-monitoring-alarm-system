# Research: an AI-coding ROI model on top of cost × DORA × manpower

Date: 2026-09-17 · Status: research complete (deep-research, 105 agents, 23 primary sources,
22/25 claims verified 3-0, 3 refuted) · Feature target: new **ROI** sub-page (feature-14)

Requirement class distilled from an anonymized enterprise brief (~$1M+/yr AI spend on Bedrock,
400+ users incl. non-engineers, per-user budgets and IAM enforcement already in place): prove
NET ROI (A/B testing exists for revenue impact, not for AI cost); project attribution with zero
approval bureaucracy; separate high- from low-value token spend; a process that turns cost data
into investment decisions; run multiple concurrent AI product bets, "attribute cost to each and
kill fast"; judge justified-vs-runaway spend (real incidents: a single agent request burning
thousands of dollars in hours); evidence-based framing that survives AI-skeptical reviewers;
patterns adoptable immediately, with cost arguments that hold without vendor credits.

## 1. The verified foundation (citation-backed)

**Use DORA's own published ROI math as the skeleton** — it is the only vendor-neutral,
formula-level, publicly inspectable model (verified verbatim against the live calculator source):

```
ROI     = (Value − Investment) / Investment          Payback = Investment / annual Value
Value   = time-saved value + throughput value + stability delta
Investment = AI spend + training + J-curve cost (+ infra)
```

- **Time-saved value** = staff × loaded cost × net-time-saved% — net of the "verification tax";
  the input floor is −100%: the framework structurally admits AI can be net-negative
  (DORA default 12.5%; published per-dev estimates 40–150 min/day).
- **Throughput value** = Δfeatures × 33% idea-success rate × 0.01–1% revenue impact × revenue
  base. DORA itself calls revenue attribution "very difficult to project" — these conservative
  conventions ARE the published Forrester-style risk adjustment.
- **Stability delta** = Δ(deployments/yr × CFR × restore-hours × $/hr-downtime) — **signed**.
  DORA's own defaults assume AI WORSENS CFR (5%→6%) while raising deployment frequency, making
  this a cost line by default. A credible model must allow it to be negative.
- **J-curve** = staff × salary × 15% productivity drop × 3 months (first-adoption, one-time).
- The 2020 DORA whitepaper adds a rework-avoided line (salary × 1.5 benefits × rework-% above
  18%) and the note that **lead time is never directly monetized** — it flows through
  deployment-frequency→experiment-capacity and time-saved→salary.
- **Framing is mandatory**: DORA labels all outputs "high-uncertainty estimates meant to spark a
  conversation" — the page must show component breakdowns + disclosed assumptions, never one
  triumphant number.

**The productivity evidence is genuinely divergent — never hard-code a multiplier:**
Peng et al. +55.8% (greenfield task, vendor-affiliated), Google enterprise RCT ~+21% (wide CI,
p=.038, self-evaluated), **METR RCT −19% for experienced devs** — present the honest bracket
**−19%…+56%**, resolved per project by the customer's own telemetry.

**Perception is disqualified as an input**: METR devs forecast +24%, measured −19%, and still
believed +20% afterwards. Ground everything in delivery telemetry and cost data; never surveys.

**Observational vs causal**: our AI-vs-human PR cohorts are observational (selection bias:
AI gets different tasks). Label them so; the published causal upgrade is a lightweight opt-in
holdout / staggered rollout (GitHub-Accenture design: random assignment, telemetry outcomes).

**Portfolio logic is research-backed**: DORA 2025's headline — AI is an **amplifier** of existing
strengths/weaknesses, not a uniform multiplier — identical spend diverges across projects. This
directly justifies per-project unit economics + a kill-fast portfolio view.

**Refuted — never cite**: the GitHub/Accenture headline numbers (+8.69% PRs, +15% merge rate,
+84% builds — killed 0-3 in verification); "the 2024 DORA report proves AI boosts individual
productivity" (killed); "the 2024 report proves AI hurts throughput/stability" (killed — use only
the calculator's own instability-default language).

## 2. The model (per project; ours = measured, theirs = config input)

| Term | Source | Notes |
|---|---|---|
| AI spend | **measured** — PROJDAY daily rollups × rate card (+ CE/CUR once the tag is active) | replaces the calculator's guessed "additional AI cost" with enforceable actuals |
| Deployments, CFR, MTTR, lead time (coding/review split), merged PRs, AI% | **measured** — DORA store per repo, pooled per project | |
| Team size, loaded $/hr (or $/yr) | input (registry per-project fields; org default) | |
| Downtime $/hr, revenue base | input with DORA defaults ($100K/hr; conventions 33% / 0.01–1%) | |
| net-time-saved% | input, default 12.5%, floor −100%, displayed against the −19%…+56% bracket; optionally telemetry-informed from the cohort lead-time split (labeled observational) | |
| Training + J-curve | input with DORA defaults; one-time flags | |

**Primary skeptic-proof view — break-even, minimal assumptions:**
`break-even hours/mo = AI spend/mo ÷ loaded $/hr` → “this project's $X/mo breaks even if it saves
Y eng-hours ≈ Z% of team capacity” → compare Z to the RCT bracket. Only two inputs, no revenue
guesses. This is the number to lead with for AI-skeptical reviewers.

**Unit economics (operational efficiency, not ROI — labeled as such):**
$/merged PR, $/deployment (already computed), tokens-per-merged-PR trend (Kiro's token-per-task
analogue). No published validation survived verification (open question) → first-principles,
flagged on-page.

## 3. High/low-value spend + runaway detection (open question → first-principles, flagged)

- **Output-linked attribution**: a project whose window has spend but zero merged PRs / zero
  deployments gets a "no shipped output in window" flag (our Delivery×Cost panel already has the
  data); registry gains an optional `category` (product / chore / experiment) so chore spend
  (e.g. bulk document-scanning chores) is separable without per-call ceremony.
- **Runaway guard**: per-request cost anomaly from our own history — alert when a
  single request exceeds max(abs floor, N × p99 of that project's request cost); lands in the
  existing anomalies pipeline. A signal, not an approval gate (the zero-bureaucracy constraint).

## 4. Forward-looking estimator (open question → first-principles on verified unit economics)

- **Reference-class from own history**: distributions (P25/P50/P90) of tokens-per-merged-PR,
  $/deployment and weekly $ per active project from PROJDAY — the estimator asks only
  "which existing project is the new one most like + expected PRs/month" and returns a budget
  **band**, not a point.
- **Projected ROI** = the §2 formula over projected inputs, break-even view first, full ROI with
  the uncertainty bracket second.
- **Kill-fast gate** (signal, not workflow): weekly, cumulative spend vs cumulative delivery
  against the reference band; two consecutive weeks of spend >P90 while delivery <P25 →
  "review recommended" flag on the portfolio view. No published predictive validity exists yet
  (open question) — presented as a heuristic with its trigger rule disclosed.

## 5. ROI page structure (executive-grade, assumption-first)

1. **Per-project ROI cards**: value/investment component waterfall (time-saved, throughput,
   stability± / tokens, training, J-curve), ROI% + payback, uncertainty bracket, assumptions
   drawer (every default editable; Forrester-style).
2. **Break-even strip** (headline for skeptics).
3. **Portfolio quadrant**: AI spend vs delivery, bubble=ROI, badge="review recommended" —
   the kill-fast view for portfolios of concurrent AI bets.
4. **Efficiency trends**: tokens/merged-PR, $/deployment per project.
5. **Cohort comparison** (existing DORA splits) labeled observational + selection-bias note +
   "run a holdout" call-to-action for causal claims.
6. **Admin inputs panel** (registry-backed; org defaults; zero approval workflow).

**What the page refuses to compute** (stated on-page): revenue attribution beyond the disclosed
conventions; survey-based savings; cross-project single multipliers; causal AI-vs-human deltas
from observational cohorts.

## Open questions (design shipped as flagged heuristics until literature catches up)

Token-spend value classification standards; FinOps GenAI forecasting prescriptions; what
Faros/Jellyfish/LinearB/DX/Swarmia compute vs refuse; validated 2–4-week kill indicators.

## Load-bearing sources

dora.dev/ai/roi (report + calculator source, verified verbatim) · dora.dev/research/2020
(ROI whitepaper) · dora.dev/research/2025 (amplifier) · arXiv 2302.06590 (Peng) ·
arXiv 2410.12944 (Google RCT) · arXiv 2507.09089 + metr.org blog (METR RCT) ·
github.blog GitHub-Accenture methodology (design only; headline numbers refuted).
