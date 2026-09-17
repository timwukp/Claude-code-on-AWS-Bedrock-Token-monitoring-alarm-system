# Research: how to present DORA metrics to a professional non-expert audience

Date: 2026-09-18 · Status: research complete, **with a disclosed evidence gap** (deep-research
run: 22 primary sources, 25 candidate claims, **14 confirmed, 0 refuted, 11 lost to provider
errors**) · Target: the **DORA** sub-page and the DORA vocabulary used across this portal.

The question this answers: our DORA page shows correct arithmetic, but the people it is built for
(engineering managers, a CTO, finance, product) are not DORA experts. Which framings do they read
correctly, which do they silently misread, and what does DORA itself actually say we are allowed
to call these numbers?

## 0. Provenance and its limits (read this before citing anything below)

The run fanned out over DORA's own primary artifacts: the 2024 *Accelerate State of DevOps*
report PDF, the current `dora.dev` four-keys guide, the `dora.dev` metrics-history insight, the
Quick Check's **source code** in the `dora-team/dora.dev` repository, Google's reference
implementation `dora-team/fourkeys`, and one mainstream vendor operationalization (GitLab's DORA
docs) as a comparison point. Each claim was extracted with a verbatim quote and then voted on by
three independent adversarial verifiers.

Two honesty notes that belong in the record, not in a footnote:

- **11 of the 25 candidate claims were never verified.** Their verifier agents died on upstream
  `503` errors, and the run's own synthesis step died the same way. They are absent here rather
  than reported at lower confidence.
- **Two of the 14 "confirmed" claims received only two votes**, not three, for the same reason
  (the definitions-page claims, §1.5 and §1.6 below). Both surviving votes confirmed at high
  confidence. They are marked where they appear.
- One further claim is directly on point but reached **only one surviving vote**, so it sits below
  the confirmation bar. It is recorded separately in §5 and is **not** used to justify any change.

Where a claim's author added a normative tail ("therefore a dashboard must…"), the verifiers
consistently flagged it as the author's inference rather than a DORA statement. Those tails are
reported as *our* design recommendations in §3, never as citations.

## 1. What DORA actually says

### 1.1 There are five metrics, not four, and one of them has a different name

`dora.dev`'s current guide lists five: **change lead time**, **deployment frequency**, **failed
deployment recovery time**, **change fail rate**, and **deployment rework rate**. The guide's own
words: *"These metrics have evolved alongside the technology landscape: shifting from the original
four keys to the current five-metric model."*

Definitions, verbatim from that page (last updated 2026-01-05):

| Metric | DORA's definition |
|---|---|
| Change lead time | *"The amount of time it takes for a change to go from committed to version control to deployed in production."* |
| Deployment frequency | *"The number of deployments over a given period or the time between deployments."* |
| Change fail rate | *"The ratio of deployments that require immediate intervention following a deployment. Likely resulting in a rollback of the changes or a 'hotfix' to quickly remediate any issues."* |
| Failed deployment recovery time | *"The time it takes to recover from a deployment that fails and requires immediate intervention."* |
| Deployment rework rate | *"The ratio of deployments that are unplanned but happen as a result of an incident in production."* |

The 2024 report groups them into two factors: **software delivery throughput** (change lead time,
deployment frequency, failed deployment recovery time) and **software delivery stability** (change
fail rate, rework rate). Recovery time counting as *throughput* rather than stability surprises
almost everyone and is worth stating on the page.

Sources: `https://dora.dev/guides/dora-metrics-four-keys/`,
`https://dora.dev/research/2024/dora-report/2024-dora-accelerate-state-of-devops-report.pdf`
(pp. 10–12), `https://dora.dev/insights/dora-metrics-history/`.

### 1.2 "MTTR" was renamed *and redefined* in 2023 — relabelling alone is not enough

The metrics-history page: the metric *"historically known as 'mean time to recover (MTTR)' or
'time to restore service' was renamed and redefined as failed deployment recovery time"*, because
*"previous definitions did not distinguish between a failure initiated by a software change and a
failure caused by external factors, such as a data center outage."* The new scope is strictly
*"restoring service after a change to production caused an impairment."*

The verifiers made the sharp point here: **a tile that measures recovery time for all incidents
and merely swaps in the new label is still measuring the wrong thing.** The scope narrowed, not
just the wording. A secondary nit from one verifier: DORA reported a *median*, so "mean time to
recover" was imprecise even before 2023.

DORA never says the old term is deprecated. The guide's own URL still contains `four-keys`, and
the Quick Check page's metadata still carries "MTTR, Time to restore" as keywords. So the accurate
framing is **"not DORA's current name or definition"**, not "superseded".

Source: `https://dora.dev/insights/dora-metrics-history/`.

### 1.3 Deployment frequency is ordinal in every DORA instrument, never a decimal rate

This is the single most useful finding for our page. DORA's own Quick Check does not ask for a
rate. It offers six ordinal buckets, verbatim from `metrics_question_responses.json` in the
`dora-team/dora.dev` repository:

| # | Bucket |
|---|---|
| 6 | On demand (multiple deploys per day) |
| 5 | Between once per hour and once per day |
| 4 | Between once per day and once per week |
| 3 | Between once per week and once per month |
| 2 | Between once per month and once every six months |
| 1 | Less than once per six months |

The question wording is *"how often does your organization deploy code to production or release it
to end users?"* Change lead time uses the same shape: *More than six months · One to six months ·
One week to one month · One day to one week · Less than one day · Less than one hour*, rendered on
the results page as `>6mo`, `1-6mo`, `1w-1mo`, `1d-1w`, `<1d`, `<1h`.

The 2024 report's performance-level table also expresses deployment frequency ordinally, never as
a rate. So a headline of "0.90 per day" is not a DORA framing. It is a defensible engineering
statistic, but it asks a reader to do a division in their head to recover the thing they care
about, which is *"about once a week"*.

Two caveats the verifiers attached: a value of exactly 1.0/day sits on the boundary between
buckets 4 and 5, so any mapping has to pick a side; and these buckets are **survey self-report
categories**, so they should not be presented as if they were measured instrument thresholds.

Sources: `https://github.com/dora-team/dora.dev/tree/main/svelte/quick-check/src/lib/data`,
2024 report p. 13.

### 1.4 The 2024 performance levels, and why change fail rate cannot yield a tier

Elite was **not** dropped. Four clusters emerged again in 2024 (Elite was absent only in the 2022
three-cluster analysis, and returned in 2023). The full published table, p. 13:

| Tier | Change lead time | Deployment frequency | Change fail rate | Failed deployment recovery time | Respondents (89% UI) |
|---|---|---|---|---|---|
| Elite | Less than one day | On demand (multiple deploys per day) | 5% | Less than one hour | 19% (18–20%) |
| High | Between one day and one week | Between once per day and once per week | 20% | Less than one day | 22% (21–23%) |
| Medium | Between one week and one month | Between once per week and once per month | 10% | Less than one day | 35% (33–36%) |
| Low | Between one month and six months | Between once per month and once every six months | 40% | Between one week and one month | 25% (23–26%) |

**Change fail rate is non-monotonic across the tiers: High is 20% while Medium is 10%.** This is
not a transcription error, and DORA discusses it directly (p. 14): *"the medium performance
cluster (orange), where throughput is lower and stability is higher than in the high performance
cluster (yellow)… We made a decision to call the faster teams 'high performers,' and the slower
but more stable teams 'medium performers.'"* The report then adds: *"This decision highlights one
of the potential pitfalls of using these performance levels."*

The consequence for us is concrete and unavoidable: **you cannot derive a tier from a change
failure rate alone.** The tiers are cluster memberships over the whole metric vector, discovered
post hoc — *"We do not set these levels in advance, rather we let them emerge from the survey
responses"* — not thresholds on individual metrics.

**Currency qualifier, flagged by all three verifiers:** the **2025** report does not publish an
Elite/High/Medium/Low table at all. It replaces the tiers with **seven team archetypes** (a chapter
titled "Understanding your software delivery performance: A look at seven team profiles", with
names such as "Harmonious high achievers" and "Foundational challenges"). So the 2024 table above
is the *latest published band set*, and any tier badge should name the report year it came from.

Sources: 2024 report pp. 12–14;
`https://cloud.google.com/blog/products/ai-machine-learning/announcing-the-2025-dora-report`,
`https://dora.dev/research/2025/dora-report/`.

### 1.5 DORA's current definitions page has no tiers at all *(2 of 3 votes)*

A text search of the four-keys guide finds no occurrence of "Elite", "High", "Medium", "Low",
"performance level", "cluster", "tier" or "benchmark", and no band table. Its only outbound
pointer is to the Quick Check.

The verifiers were emphatic that this must **not** be read as "DORA abandoned tiers" — the clusters
live in the report PDFs. The correct reading is narrower and more useful: **a tier badge is not
sourced from the canonical definitions, so it has to cite a specific report year.**

### 1.6 The Quick Check itself shows a 0–10 score against a benchmark, not a tier *(2 of 3 votes)*

The current Quick Check source contains no tier labels either. It scores each metric 0–10 and plots
it against an industry (or organization-size) **mean and standard deviation**, grouped under
"Software delivery throughput" and "Software delivery stability", with a legend of *Average ·
Standard deviation · Your performance*. The scoring in `data-service.ts` recodes the 1–6 survey
buckets onto 0–10, and percentage metrics from 0–100 onto 10–0 (inverted, so 10 is always best).
The stored field is `software_delivery_instability`, which the tool inverts (10 − mean) for display.

The 2025 "all industries" benchmarks it compares against:

| Metric | Mean | Std dev |
|---|---|---|
| Lead time | 5.5 | 2.4 |
| Deployment frequency | 4.8 | 2.8 |
| Change failure rate | 1.9 | 2.1 |
| Failure recovery | 7.4 | 2.1 |
| Rework | 2.2 | 2.2 |
| Overall performance | 4.3 | 1.2 |

So DORA maintains **two coexisting presentation modes**: distance-from-peer-mean in the interactive
tool, and named clusters in the annual report. Neither is "the" DORA way to show a number.

Source: `https://github.com/dora-team/dora.dev/tree/main/svelte/quick-check/src/lib/data`
(repo HEAD `b14ae080c350`, 2026-07-29).

### 1.7 DORA's own caveats on the tiers are stronger than most dashboards admit

Verbatim, 2024 report p. 74:

> The four key metrics should be used at the application and service levels, and not at the
> organization or line-of-business level. The metrics should be used to visualize your efforts in
> continuous improvement and not to compare teams — and certainly not to compare individuals. The
> metrics should also not be used as a maturity model for your application or service teams. Being
> a low, medium, high, or elite performer is interesting, but we urge caution as these monikers
> have little value in the context of your transformation journey.

And pp. 14–15: *"The best teams are those that achieve elite improvement, not necessarily elite
performance."*

Worth being fair about the tension: **the same report also headlines the tiers and the
elite-versus-low multipliers** (127× faster lead time, 182× more deployments), framed as
*"intended to help inspire all that elite performance is achievable."* DORA both uses and caveats
its own labels. The defensible conclusion is therefore to **contextualize** the badge, not to
delete it.

The current four-keys guide corroborates the caution and does not mention the tiers at all:
*"These metrics are meant to be applied at the application or service level"*, *"The goal is to
improve your team's performance over time, not to compete against other teams or organizations"*,
plus an explicit warning about Goodhart's law.

### 1.8 Merge-to-main is a proxy, and DORA's own tooling says so

Production deployment is the anchor for every DORA definition. A grep of the full 2024 report text
for "merge", "pull request", "MTTR" and "restore" returns **zero hits**.

Google's reference implementation, `dora-team/fourkeys`, is even more direct. It computes
deployment frequency as `COUNT(distinct deploy_id)` over deploy events, and lead time as
`deploy.time_created − change.time_created`. It states that a pull-request merge's push event
*"is not its own distinct change, but rather a link in the workflow"*, and that triggering
deployment metrics off it *"artificially skews the metrics"*.

Note carefully **which half of our definition is the problem.** DORA's change lead time *starts at
commit to version control*, which is exactly what our page measures (first commit → merge). The
start point is right. It is the **end point** that is a proxy: we stop at merge, DORA stops at
production. One verifier put the recommendation plainly — disclosure text should cite DORA's
commit-to-production definition as the reference standard, and treat any vendor variant as one
operationalization.

Sources: `https://dora.dev/guides/dora-metrics-four-keys/`, `dora-team/fourkeys` `METRICS.md`,
2024 report footnote 1 (*"a change that is stopped on its way to production is a successful
demonstration of the deployment process's ability to detect errors"*).

### 1.9 The vendor comparison cuts both ways

GitLab is a useful reality check because it faces the same problem we do, and its answers are
instructive rather than authoritative.

- **It does publish a fractional per-day rate.** *"Deployment frequency is calculated as the
  average (mean), unlike the other DORA metrics that use the median."* So per-day rates are
  industry-accepted. But GitLab itself explains the mean as a **legacy artifact**: *"deployment
  frequency was added to GitLab prior to adopting the DORA framework, and the calculation of this
  metric remained unchanged when it was incorporated"*, and says the median *"is preferred because
  it provides a more accurate and reliable view of performance."* The verifiers were unanimous
  that this is precedent for the framing being *common*, not evidence that it is *comprehensible*.
  GitLab also offers hourly / daily / weekly / monthly / yearly granularity, so per-day is a
  default rather than a definition.
- **Its lead time is narrower than DORA's, not broader.** It runs from merge-button click to
  production: `GREATEST(0, deployment_finished_at − merge_request_merged_at)`, *"without adding
  the coding_time to the calculation"*. That window and ours are **disjoint** — ours ends exactly
  where GitLab's begins. Our first-commit start point is closer to DORA proper than GitLab's is.
- **Its change failure rate needs incident records:** *"the number of incidents divided by the
  number of deployments to a production environment"*, with time to restore as *"the median time
  an incident was open on a production environment"*. Its documented assumptions include that
  incidents are tracked in GitLab and that *"incidents and deployments have a strictly one-to-one
  relationship"*.

On that last point the verifiers overturned the claim's own conclusion, and it matters for us.
Counting reverts and hotfixes is **conceptually aligned with DORA's canonical wording** ("a
rollback of the changes or a 'hotfix'") — arguably more directly than an incident ratio is.
GitLab's method has its own documented failure modes: duplicate incidents double-count (its issue
480920), there is no deployment-to-incident linkage (issue 444295), all incidents count regardless
of environment, the ratio can exceed 100%, and it silently reads 0% when teams simply never file
incidents. The honest framing is **two different detection methods with different false-negative
modes**, not a strong one and a weak one. Our real exposure is narrower and specific: **title
regexes miss reverts and hotfixes that were not named like reverts and hotfixes.**

Source: `https://docs.gitlab.com/user/analytics/dora_metrics/`.

## 2. What this means for the DORA page as it stands today

Measured against the evidence above, five things on the shipped page are wrong or
under-disclosed. Each is a labelling and framing defect, not an arithmetic one.

| Where | Today | Problem |
|---|---|---|
| `backend/lambdas/dora/dora-calc.ts` deployment-frequency tiers | decimal boundaries `1`, `1/7`, `1/30` per day | DORA's bands are ordinal. The decimals are a re-derivation of "per day / per week / per month" that loses the words the reader needs. |
| same file, change-failure-rate tiers | monotonic `≤5% / ≤10% / ≤15%` | The published 2024 bands are non-monotonic (High 20%, Medium 10%). A per-metric CFR tier is not derivable and cannot be attributed to DORA. |
| same file, `mttr` | named MTTR, computed over hotfix PRs **and all bug/incident issues** | Both the name and the scope are pre-2023. Failed deployment recovery time covers only impairments caused by a change reaching production. |
| `frontend/src/pages/DoraPage.tsx` KPI and panel labels | "How often do we ship?", "Deployments per week" | Merge-to-main is a proxy for deployment frequency. The disclosure exists in a footnote under the grid, but the number itself reads as measured deployments. |
| the page's framing sentence | "These are the four DORA metrics" | DORA has had five since 2024. We do not collect rework rate, which is a legitimate gap to state rather than a count to misreport. |

Two things the page already gets right and should keep: lead time starts at first commit, which
matches DORA's start point, and the AI-assisted versus human-only split is already labelled as
observational elsewhere in the portal.

## 3. Recommended presentation (our design inference, not DORA doctrine)

The through-line of every confirmed claim is that **DORA's own instruments lead with a phrase and
keep the number subordinate.** "Between once per day and once per week" is the finding; `0.9/day`
is the intermediate arithmetic. A professional non-expert reads the phrase correctly on the first
pass and cannot misread it.

1. **Lead with the ordinal band, show the rate as supporting detail.** Headline "about once a
   week", with the computed rate and the sample size underneath. Use DORA's six bucket strings
   verbatim so the label is citable. Pick and document the boundary rule at exactly 1.0/day.
2. **Say "proxy" at the number, not in a footnote.** The label should carry it: *deployment
   frequency proxy — PRs merged to the default branch*. The reader who only reads headlines is
   exactly the reader who must not miss this.
3. **Use DORA's current names, and fix the scope behind the renamed one.** "Failed deployment
   recovery time" over MTTR — and only if the underlying computation is narrowed to
   change-caused impairments. If it stays incident-wide, keep a distinct name and say what it
   measures. A rename over an unchanged definition is a worse outcome than the old label.
4. **Stop deriving a tier from change failure rate.** The bands are non-monotonic, so the per-metric
   badge is not attributable. Show the measured percentage against the four published band values
   as reference marks, or drop the badge on that metric alone.
5. **Date every tier badge.** "High (2024 DORA bands)". The 2025 report replaced the tiers with
   seven archetypes, so an undated badge is a claim about a framework that has since moved.
6. **Keep the badge, add the caveat DORA itself prints.** One line under the grid, in DORA's own
   terms: these are annual survey-population benchmarks, applied per application or service, and
   improvement matters more than the label. Do not present them as grades or a maturity model.
7. **Say five metrics, and name the one we do not collect.** Rework rate needs a signal for
   unplanned deployments that we do not have. Stating the gap costs nothing and buys the rest of
   the page credibility with the reader who knows the framework.
8. **Describe the change-failure detection method where the number appears.** "Reverts and hotfixes
   identified from PR titles, plus issues labelled bug or incident" — with the false-negative mode
   named. A "0 — clean" tile has to be readable as *nothing matched our detectors*, not as
   *nothing broke*.

Deliberately **not** recommended: switching to an incident-record-based change failure rate.
The evidence does not support it as an upgrade, and it would replace a known false-negative mode
with a worse one for teams that do not file incidents.

## 4. Wording that survives a non-expert reader

| Metric | Headline label | The one-line explanation |
|---|---|---|
| Deployment frequency (proxy) | How often do changes reach main? | Ordinal band first, e.g. "between once per day and once per week". A deployment here is a PR merged to the default branch, which is a proxy: DORA counts production deployments. |
| Change lead time (partial) | How long from first commit to main? | DORA measures commit to production. We measure commit to merge, so this is the first part of DORA's window, not all of it. |
| Change fail rate | How often does a change need a revert or hotfix? | Percentage of merged changes followed by a revert, a hotfix, or a bug or incident issue. Detected from PR titles and issue labels, so it undercounts anything not named that way. |
| Failed deployment recovery time | How long to recover once a change breaks something? | Median time from the problem being recorded to the fix merging. DORA scopes this to failures caused by a change reaching production. |
| Deployment rework rate | Not collected | Requires a signal for deployments that were unplanned fixes. We have no such signal today. |

## 5. Below the confirmation bar — recorded, not relied upon

One claim reached only a single surviving verifier vote after two agents crashed. It is directly
relevant, so it is recorded here and used for nothing.

> DORA warns against setting metric values as goals (Goodhart's law) and against using the metrics
> to compete or compare across teams and applications.

The quoted source text (four-keys guide) is: *"Setting metrics as a goal. Ignoring Goodhart's law
and making broad statements like, 'Every application must deploy multiple times per day by year's
end,' increases the likelihood that teams will try to game the metrics."*; *"Making disparate
comparisons. These metrics are meant to be applied at the application or service level."*;
*"Competing. The goal is to improve your team's performance over time, not to compete against
other teams or organizations."*

The surviving verifier narrowed it twice, and both narrowings are worth keeping. The page's
pitfalls are distinct rather than interchangeable: gaming follows from goal-setting, misleading
conclusions from comparing unlike applications, and finger-pointing from siloed metric ownership.
And an AI-assisted versus human-only cohort comparison **within a single repository** is not
literally the cross-team comparison DORA warns about — that inference was the claim author's, not
the source's. Since §1.7 already establishes the same caution from a fully confirmed primary
source, nothing in §3 depends on this claim.

## 6. Sources

| Source | Type |
|---|---|
| `https://dora.dev/guides/dora-metrics-four-keys/` (updated 2026-01-05) | primary — current definitions |
| `https://dora.dev/research/2024/dora-report/2024-dora-accelerate-state-of-devops-report.pdf` (v. 2024.3, 120 pp.) | primary — performance levels, factors, caveats |
| `https://dora.dev/insights/dora-metrics-history/` (updated 2026-01-02) | primary — the 2023 rename, the 2024 fifth metric |
| `https://github.com/dora-team/dora.dev/tree/main/svelte/quick-check/src/lib/data` | primary — Quick Check buckets, scoring, benchmarks |
| `dora-team/fourkeys` `METRICS.md` | primary — reference implementation, merge ≠ deploy |
| `https://cloud.google.com/blog/products/ai-machine-learning/announcing-the-2025-dora-report` · `https://dora.dev/research/2025/dora-report/` | primary — 2025 team archetypes replace the tiers |
| `https://docs.gitlab.com/user/analytics/dora_metrics/` | vendor operationalization, used as comparison only |
