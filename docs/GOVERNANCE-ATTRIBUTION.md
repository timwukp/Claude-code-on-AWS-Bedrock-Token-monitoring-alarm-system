# Attribution governance — rule C

Decided by the owner on 2026-10-24 after the F-004 investigation (a project with 33 AI-assisted merges and $0 attributed
spend, because its callers carried no attribution signal). The dashboard cannot invent a project for a call; the signal
must exist when the call is made. Rule C says which signals count and in what order.

## The rule
1. **Application inference profile (AIP) — the standard for every project.** A call routed through the project's AIP logs
   the AIP ARN as `modelId`; the registry resolves the `tums-project` tag. IAM can enforce it (allow `bedrock:Invoke*`
   only on the project's profiles), so unattributed traffic trends to zero. New projects get their profiles with
   `scripts/create-project-aip.sh <project> <model-id>...`, which also prints the `.claude/settings.json` snippet
   (`ANTHROPIC_MODEL`, `ANTHROPIC_SMALL_FAST_MODEL`) that makes Claude Code — CLI and Desktop alike — use them for
   that repository.
2. **Registered identity — for callers that cannot be changed.** A role (`arn:aws:iam::<acct>:role/<Role>`; every
   assumed-role session collapses to it) or an IAM user, including Bedrock API-key users (`user/BedrockAPIKey-*`),
   registered in Settings → Project registry. One identity belongs to exactly one project; a key used across several
   repositories cannot be attributed this way and must move to AIPs.
3. **`requestMetadata.project_id`** set by the calling application.
4. **`untagged`** — shown, never hidden. The By project page lists the largest unattributed callers so the gap is a
   to-do list, not a bucket.

## Where it runs
- At ingest: the aggregator (`parse.ts deriveProject`) and the lakehouse transform attribute best-effort.
- In silver: `spec/lakehouse/sql/silver_20_attribution_merge.sql` recomputes `project_id` / `attribution_source` from the
  current registry snapshot, so registering an identity today re-attributes the last 90 days by tomorrow.
- `attribution_source` ∈ `aip | identity | metadata | workspace | none` records which tier decided.

## Not implemented, by design
A **workspace hint** (reading the working directory Claude Code prints inside its prompt — `Primary working directory:
/…/<repo>`) would attribute shared-key traffic per repository. It requires parsing prompt text and is therefore
**off until the owner consents in writing**; the enum value exists so the decision is visible in the data.

## Known gap
The legacy aggregator orders `requestMetadata` before identity; silver follows rule C (identity before metadata).
`scripts/verify-lakehouse.ts` reports rows where the two orders disagree; aligning the aggregator is a P3 item.
