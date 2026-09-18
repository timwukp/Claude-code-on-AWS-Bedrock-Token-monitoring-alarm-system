# Spec: one tile, one measurement — DORA copy density

- **Intent:** ./intent.md
- **Author:** Claude (AI agent)
- **Accepted-by:** Tim WU
- **Status:** signed-off

## Behaviour

### 1. Tile contract

Every KPI tile on the DORA page satisfies:

| Slot | Rule |
|---|---|
| Label | A canonical noun phrase from `https://dora.dev/guides/dora-metrics/`. No questions, no parentheticals. |
| Chip | At most one, and only when the tile's relationship to the canonical metric is not exact: `proxy`, `partial`, `not DORA's`, `not collected`. |
| Value | One number, in the unit a reader compares with (per-week rate, hours, percent) — or `—` when there is no sample. |
| Foot | Exactly one line of **sample provenance**: what was counted, over what window. No definitions, no bands, no cohort split. |

The five delivery tiles:

| Group | Label | Chip | Value | Foot |
|---|---|---|---|---|
| Throughput | Deployment frequency | `proxy` | `6.3 / week` | `27 merges to main · 30 days` |
| Throughput | Change lead time | `partial` | `1.6 h` | `median first commit → merge · 27 changes` |
| Stability | Change fail rate | — | `0%` | `0 of 27 changes reverted, hotfixed or tied to an incident` |
| Stability | Recovery time | `not DORA's` | `—` | `no hotfixes or incidents in this window` |
| Stability | Deployment rework rate | `not collected` | `—` | `needs a planned-vs-corrective deployment signal` |

Group headings are `Throughput` and `Stability` under DORA's own umbrella term *software delivery
performance*. Recovery time sits under **Stability** — three of DORA's four first-party surfaces
place it there, including its own live instrument, even though the definitions guide files it under
throughput.

### 2. No band, tier or benchmark on any face

`TierBadge`, the tier accent colour and the short band headlines (`About weekly`, …) are removed
from the page. The 2024 band values remain available as **data** and are rendered once, inside the
disclosure, as a dated reference table. Deployment frequency leads with the measured per-week rate.

No percentile is shown either: the percentile view is the defensible substitute for a band, and it
requires a benchmark distribution this product does not have. The disclosure states that as the
reason rather than leaving the absence unexplained.

### 3. The AI metric leaves the DORA grid

`AI-assisted changes` becomes the headline KPI of the cohort panel, not a sixth DORA tile. Its foot
names exactly what is counted: `3 of 27 PRs carry an AI co-author trailer (Claude Code 1 · Kiro 2)`.
It is attributed to this product's own method documentation, because no DORA term for AI-authored
share exists to attribute it to.

### 4. Cohort split becomes a row, not caption text

The `Lead time breakdown` panel becomes **`AI-assisted vs human-only`** and carries, per cohort:
merges, coding hours, review hours, total lead time, p95, and change fail rate. Its `Tier` column is
removed. Every `· AI-assisted n · human-only n` fragment comes out of the tile feet. The note that
the stage medians are independent and need not sum stays with the table.

### 5. One disclosure, keyboard-openable

A single `Definitions & limitations` disclosure, built on native `<details>/<summary>` so it opens
by keyboard and touch without ARIA wiring, absorbs:

- the canonical-label table: DORA's label, DORA's one-line definition, and **our deviation** per
  metric, attributed to `dataSource.canonicalSource` as a link;
- the dated 2024 band reference table from `dataSource.bandReference`, plus `cfrReference` with the
  reason no change-fail band is shown (the published values are non-monotonic across the levels);
- the merge-as-deployment proxy note, including DORA's own tooling warning;
- the detector's false-negative mode — `0% means nothing matched those detectors`;
- the lead-time end point, the recovery-time scope, the AI-trailer definition, and that incidents
  count only under All;
- why no benchmark appears on the face.

Coverage state stays **out** of the disclosure and on the face: `not collected` and an empty sample
are findings about this tenant's data.

### 6. Tables

`All tracked repositories` and `Projects — delivery × cost` drop every badge. The deployment-frequency
cell is the measured rate; the lead-time and recovery cells are the measured hours; a repo or
project with no sample renders `—`.

### 7. Payload

`changeFailureRate` is renamed `changeFailRate` on the metrics, overview and project payloads, and
the interface `ChangeFailureRate` becomes `ChangeFailRate`. `dataSource` gains:

- `canonicalSource: 'https://dora.dev/guides/dora-metrics/'` — one surface, cited by URL, because
  DORA's own surfaces disagree with each other about these labels;
- `bandReference` — the 2024 thresholds in human units for every metric that has a band, `cfr`
  excluded by construction.

`DATA_SOURCE.notes` carries one claim per note, and the note asserting that the band leads with the
rate as supporting arithmetic is **deleted**, because it is now false.

## Out of scope

- Any change to a computed metric value.
- Collecting a rework-rate signal, or narrowing the recovery-time scope to DORA's definition.
- Charts: titles keep the proxy wording already shipped; no chart is restructured.
