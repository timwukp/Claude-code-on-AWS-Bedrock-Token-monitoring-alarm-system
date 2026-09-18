# Research: how to word DORA metric cards so the copy is terse *and* defensible

**Question.** The DORA page states its metrics correctly but reads as verbose: three competing
headlines for the same fact, four categories of information run together in one caption line, and
definitional constants repeated on every render. What is the shortest *professionally correct*
wording for each metric, what should lead the tile, and what belongs behind disclosure?

**Method.** Five research angles, 23 sources fetched, 20 candidate claims, each put to three
independent adversarial verifiers (a claim dies on 2 of 3 refutes). 8 findings survived. Votes and
source URLs are recorded per finding so a reviewer can re-check any of them.

**Companion document.** `research-dora-presentation.md` established *what* the metrics are. This one
is about *how to say it*. Where the two disagree, this one is later and wins — see finding 4, which
overturns a decision made on the strength of the earlier pass.

---

## 1. The canonical labels are five short noun phrases — 3-0, high confidence

`https://dora.dev/guides/dora-metrics/` (last updated 2026-01-05) prints, verbatim:

| Label | DORA's own one-line definition |
|---|---|
| **Change lead time** | "The amount of time it takes for a change to go from committed to version control to deployed in production." |
| **Deployment frequency** | How often an organization successfully releases to production. |
| **Failed deployment recovery time** | "The time it takes to recover from a deployment that fails and requires immediate intervention." |
| **Change fail rate** | "The ratio of deployments that require immediate intervention following a deployment." |
| **Deployment rework rate** | "The ratio of deployments that are unplanned but happen as a result of an incident in production." |

Two details that change our code and copy:

- It is **"Change fail rate"**, not "change failure rate". Zero hits for "change failure rate" in
  DORA's own live instrument. Our `changeFailureRate` identifier and label are both off-spec.
- **"MTTR" / "time to restore service" and the "four keys" count are explicitly historical.** The
  guide describes "shifting from the original four keys to the current five-metric model" and "the
  move from MTTR to Failed Deployment Recovery Time"; `insights/dora-metrics-history/` dates the
  rename to the 2023 report and the fifth metric to 2024.

**Caveat the verifiers insisted on:** the 2023 change was a rename **and** a scope narrowing —
failures *caused by a deployment*, not generic incidents. A dashboard computing generic-incident
recovery must not simply adopt the new name. Our page already refuses to.

Sources: `dora.dev/guides/dora-metrics/` · `dora.dev/insights/dora-metrics-history/` ·
`github.com/dora-team/fourkeys`

## 2. dora.dev contradicts itself, so cite one surface by URL — 3-0

The same organisation ships three different label sets:

| Surface | Lead time | Frequency | Rework |
|---|---|---|---|
| Definitions guide | Change lead time | Deployment frequency | Deployment rework rate |
| Quick Check result cards | Lead time for changes | Deployment frequency | Rework rate |
| Quick Check question objects | Lead time | Deploy frequency | Deployment rework rate |

A verifier grepped the live 350,646-byte Quick Check bundle to establish this. **Rule for our copy:**
use the definitions guide's five phrases as tile labels, and attribute the definitions drawer to
`https://dora.dev/guides/dora-metrics/` specifically — never to "DORA" generically, which is
unfalsifiable and, given the above, not even true.

Sources: `dora.dev/quickcheck/` · `dora.dev/guides/dora-metrics/`

## 3. "Software delivery performance" is DORA's umbrella; the two-way split is contested — 2-1 on the grouping, 3-0 on the umbrella

DORA's own prose: "DORA has identified five software delivery performance metrics" and "DORA now
utilizes five metrics to measure software delivery performance, grouped into two distinct factors".
So the group heading is first-party.

The *split* is not settled, and the disagreement is inside DORA's own lineage:

- The definitions guide: throughput = lead time, frequency, **recovery time**; instability = fail
  rate, rework rate.
- DORA's Quick Check renders "Software delivery throughput" and "Software delivery **stability**",
  with **recovery time on the stability side**.
- Google Cloud's Four Keys blog and *Accelerate* both put recovery time with stability.

**Decision:** use **Throughput / Stability** with recovery time under stability — three of the four
first-party surfaces agree, including DORA's own live instrument. Do not present the guide's
"Instability" grouping as an uncontested standard.

Incidental correction: do not repeat Google Cloud's "introduced in 2013" — dora.dev's history page
dates the four variables to the inaugural **2014** study.

Sources: `dora.dev/guides/dora-metrics/` · `dora.dev/insights/dora-metrics-history/` ·
`dora.dev/quickcheck/` · `cloud.google.com/blog/products/devops-sre/using-the-four-keys-to-measure-your-devops-performance`

## 4. Do not headline an ordinal band — 3-0, high confidence

**This overturns a decision we shipped.** The previous research pass established that the 2024 band
values are non-monotonic and cannot be derived per-metric; the correct conclusion drawn from it was
to stop badging change fail rate. The *incorrect* conclusion was to promote the band to the
deployment-frequency headline.

DORA's own live first-party instrument does not use bands at all. The Quick Check results template
is `<b class=level-label>Overall Performance</b>` under `<h1>Your software delivery performance</h1>`,
fed by `performanceAverage.toFixed(1)` — a **continuous 0–10 score** against
`industry_score = performance_average?.mean` and `std`, with tickmarks `[0,2,4,6,8,10]` and a
three-item legend (Average, Standard deviation, Your performance). Scoring is continuous *by
construction*: `De(e,1,6,0,10)` for categorical answers, `De(e,0,100,10,0)` for percentages — no
bucketing anywhere. The strings Elite, Medium, archetype, cluster, profile and performer appear
**zero times as labels** in the bundle.

Also relevant to our fifth tile: the rework card renders **only** on the 2025 benchmark edition, and
2024-edition users get a prompt to answer the new question. **DORA itself gates the fifth metric on
data availability rather than showing a blank band** — which is precisely the "not collected" tile
pattern our page adopted.

Source: `dora.dev/quickcheck/`

## 5. The 2025 report replaced the levels with clusters, so the substitute is a percentile — 2-1

Text-extracted from the official PDF (v2025.2, published 2025-09-24): **zero** occurrences of
"elite", "high performer" or "low performer"; **75** of "cluster". Figure 2 is captioned
"Performance levels of seven team archetypes". The 2023 and 2024 reports both still contain the
four-row Elite/High/Medium/Low table, so the timing is right.

The report also ships a "How do you compare?" **percentile** view ("% at level" / "Top %" per
metric, Figures 11–15). That is the defensible on-tile substitute for a band.

**Archetype names must not go on a tile.** The report's own caveat argues against it: "The names and
descriptions for each of these clusters are an interpretation of the data. Your team may see similar
performance levels as a given cluster but may not feel the cluster name or description describe your
team well."

Rated medium, not high, because the dissenting verifier could not find this material on stable
dora.dev HTML pages (`/research/2025/dora-report/team-profiles/` 404s) — the evidence is the report
PDF plus a questions page.

Sources: `cloud.google.com/blog/products/ai-machine-learning/announcing-the-2025-dora-report` ·
`dora.dev/research/2025/team-profiles/questions/`

## 6. Vendors still ship the legacy four names — but that is not licence to contradict dora.dev — 3-0

| Product | What its DORA surface calls the metrics |
|---|---|
| GitLab | four metrics incl. "Time to restore service"; no rework metric |
| Swarmia | deployment frequency, change lead time, change failure rate, **mean time to recovery** |
| LinearB | Deploy Frequency, Change Failure Rate, **Cycle Time**, Mean Time to Recovery |
| Harness | Lead Time, Deployment Frequency, **MTTR**, Change Failure Rate |

So shipping legacy names would not read as an error to a buyer — but nor is vendor consensus a
counter-authority to the primary source. Use dora.dev's names and let the drawer note the older ones.

**Google's Four Keys cannot be cited as current authority.** The GitHub API reports
`archived = true`, `pushed_at = 2024-01-23`, banner "This repository is not currently maintained."
It stays legitimately citable for pre-2024 naming history **and for implementation/proxy conventions
— treating a merge or commit event as a deployment signal** — but not for the 2023 rename, the 2024
fifth metric, or the 2025 archetypes.

Sources: `docs.gitlab.com/user/analytics/dora_metrics/` · `github.com/dora-team/fourkeys` ·
`swarmia.com/dora-metrics/` · `linearb.io/platform/dora-metrics` · `harness.io/blog/dora-metrics`

## 7. Progressive disclosure for definitions — but not hover-only, and coverage stays on the face — 2-1

GitLab's docs: "When you hover over a metric, a tooltip displays an explanation of the metric and a
link to the related documentation page." Structural corroboration: its panel YAML schema exposes
only `title`, `queryOverrides`, `visualization`, `gridAttributes` — there is **no per-panel
description field**, so the tile face structurally *cannot* carry definition prose. Faces carry
metric name, value, change %, and a trend sparkline; full definitions and the threshold table live
in docs.

Two qualifications the verifier required:

1. This is evidence about **definitions**, not about proxy or provenance disclosure. It must not be
   stretched to cover the latter (see finding 8).
2. **Hover-only fails.** NN/g: "Important information should always be on the page; therefore,
   tooltips shouldn't be essential" — plus discoverability and WCAG 1.4.13 keyboard concerns. The
   disclosure layer must be a keyboard- and touch-accessible drawer or glossary.

Conversely, the same GitLab page keeps a **"Not included" legend series** for projects excluded from
scoring, **on the chart face** — direct vendor precedent for showing coverage state rather than
hiding it.

Sources: `docs.gitlab.com/user/analytics/value_streams_dashboard/` ·
`nngroup.com/articles/tooltip-guidelines/`

## 8. Three of the five angles have no evidence base — all candidates refuted

This is the most important finding for how the rewrite is *justified*.

| Angle | Outcome |
|---|---|
| Empirical evidence that long caveat text harms comprehension or trust | **refuted 0-3.** The annotation study (302 participants, univariate line charts) can be cited neither for nor against terse cards without re-reading it. |
| A vendor pattern for disclosing proxy measurement | **refuted 0-3.** The supporting claim — that DORA endorses approximate measurement over precise integration — did not survive. |
| A DORA-sanctioned term for AI-authored contribution share | **refuted 1-2 and 0-3.** "AI adoption" is plausible but unverified; it denotes a *survey self-report* of AI use and perceived productivity. **No source at all** was established for SPACE, the DevEx framework, Forsgren's later work, or any industry term for AI-authored code share. |

**Consequences we must accept rather than paper over:**

1. Terseness is justified on **scanability, buyer credibility and layout** grounds. It is a design
   judgement, not a research finding, and must not be dressed as one.
2. Our proxy wording ("a merge to the default branch stands in for a production deployment") is
   **our own choice**, with only Four Keys' implementation convention as lineage — not a cited
   pattern.
3. The AI metric must **name exactly what the pipeline counts** — pull requests carrying an AI
   co-author trailer — and be attributed to our own method documentation. A label like "How much did
   AI help write it?" claims a code-authorship measurement we do not have.

Sources: `arxiv.org/abs/2208.01780` · `dora.dev/guides/dora-metrics/` ·
`cloud.google.com/blog/products/ai-machine-learning/announcing-the-2025-dora-report`

---

## What this means for the page

**Card shape:** one canonical noun label, at most one qualifier chip, one headline number, one line
of sample provenance. Everything else moves into a single accessible "Definitions & limitations"
drawer.

| Label | Chip | Headline | Provenance line |
|---|---|---|---|
| Deployment frequency | `proxy` | rate per week | merges to main · window |
| Change lead time | `partial` | median hours | first commit → merge · n changes |
| Change fail rate | — | percentage | n of N changes reverted or hotfixed |
| Recovery time | `not DORA's` | median hours or — | scope note |
| Deployment rework rate | `not collected` | — | the signal that is missing |
| AI-assisted changes | — | percentage | n of N PRs carry an AI co-author trailer |

**The rate leads; the band does not.** The 2024 band, DORA's verbatim ordinal phrase, and the proxy
explanation all move into the drawer. We do not have the benchmark distribution needed for the
percentile that finding 5 identifies as the defensible substitute, so we show no benchmark on the
face and say why in the drawer — consistent with how the rest of this product refuses numbers it
cannot support.

**Cohort comparison** (AI-assisted vs human-only) becomes its own row, not caption text: it is a
second data dimension, not provenance.

**Coverage and "not collected" states stay on the card face** (finding 7), with DORA's own gating of
its rework card as precedent (finding 4).
