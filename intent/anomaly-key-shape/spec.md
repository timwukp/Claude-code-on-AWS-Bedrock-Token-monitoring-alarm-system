# Spec: one key definition, plus a one-off repair of the rows already written

- **Intent:** ./intent.md
- **Author:** Claude (AI agent)
- **Accepted-by:** Tim WU
- **Status:** signed-off

## Behaviour

### 1. `backend/lambdas/shared/anomaly-key.ts` is the only definition of the key

A new module exports the whole key shape and nothing else:

| Export | Value |
|---|---|
| `ANOMALY_SK_PREFIX` | `'ANOMALY#'` — the prefix the reader filters on |
| `anomalyPk(tenantId)` | `TENANT#<tenantId>` |
| `anomalySk(detectedAt, type, discriminator)` | `ANOMALY#<detectedAt>#<type>#<discriminator>` |

All three call sites import it: the writer in `anomaly-response/index.ts`, the writer in
`ingestion/aggregator.ts`, and the reader in `api/anomalies.ts`. No literal `TENANT#` or `ANOMALY#`
fragment for this table remains anywhere else, because the defect was not a typo — it was two
spellings of one fact, and leaving a third spelling in place preserves the hazard that produced it.

Three properties are load-bearing and are asserted in the unit tests rather than left to review:

- **`detectedAt` leads the sort key.** String ordering is therefore chronological ordering, which is
  the only reason the reader's existing `ScanIndexForward: false` returns newest-first without a
  secondary index. Putting `type` first would silently turn the feed into type-major order and cost a
  GSI to undo.
- **The prefix is applied by `anomalySk`, not by its callers.** A caller that can forget the prefix
  is a caller that will, which is precisely how `anomaly-response` drifted.
- **Keys are deterministic.** Identical input yields an identical key, so re-processing the same batch
  re-puts one item instead of appending a duplicate alert to a security feed. The discriminator —
  a request id, a source IP — is whatever distinguishes two anomalies of the same type at the same
  instant, and it must be derived from the event, never generated.

### 2. Reader and writers are unchanged in every other respect

The `/v1/anomalies` key condition (`pk = :pk AND begins_with(sk, :skPrefix)`), its
`ScanIndexForward: false`, its response fields and the page that renders them are untouched. This
chain makes the existing query find the existing items; it does not redefine either.

### 3. Repairing the rows already in the table

The alerts written on the unreadable shape stay in the table until something rewrites them, so
`anomaly-key.ts` also exports the repair vocabulary — key-shape knowledge belongs with the key
definition, not in a script:

- `AnomalyTableItem` — an item as scanned, since the table also holds non-anomaly partitions.
- `tenantOf(pk)` — recovers the tenant from **either** shape; `null` when the partition is not an
  anomaly partition at all, so a scan cannot rewrite an unrelated row.
- `targetKeys(item)` — the corrected keys, or `null` when the item already conforms. It checks
  **both** halves independently, because the two halves drifted independently and a correct `pk`
  does not imply a correct `sk`. `detectedAt` and `type` are read from the item's own **attributes**
  in preference to re-parsing the legacy sort key: a source IP is not guaranteed to be `#`-free, and
  the attributes are what the page renders anyway.

`backend/scripts/migrate-anomaly-keys.ts` applies it, in the style of the existing
`backfill-projday.ts`:

- **Dry run by default.** It prints the rewrite plan (`<n> already readable, <m> to rewrite`, then
  each `from -> to` pair) and exits. `--apply` is required before anything is written.
- The replacement is `Put` under `ConditionExpression: attribute_not_exists(pk)`, so a second run
  cannot clobber a migrated or hand-fixed item.
- The legacy row is deleted **only after** its replacement is confirmed written. A crash between the
  two leaves a duplicate, which the next run detects and cleans. The failure direction is a
  duplicated alert, never a lost one.
- Conforming items are counted and skipped, so the script is safe to re-run, and a clean re-run is
  the verification that the migration worked.

### 4. Rider: `fmtTokens` scales past `M` and groups its digits

`fmtTokens` gains the tiers above `M` (`B`, then `T`) and a **pinned** `en-US` locale for grouping and
its two decimals, matching what `fmtUsd` already does. The locale is pinned rather than left to the
browser for the same reason it is pinned there: an unpinned locale renders a comma-decimal reading of
a figure the rest of the page states in `en-US` form, which is the same defect mirrored.

## Out of scope

- Any new table, GSI or secondary index; any change to the anomalies table's provisioning.
- Anomaly detection itself — thresholds, severities, and what qualifies as an anomaly.
- The `/v1/anomalies` response contract and the page that consumes it.
- A general-purpose or scheduled key-migration facility. The migration is a one-off and is deleted or
  left inert once applied; standing tooling for a shape that should never recur would keep the shape
  alive.
- Backfilling anomalies for periods when no detector ran. Nothing was written, so there is nothing to
  repair, and inventing rows would fabricate security evidence.
