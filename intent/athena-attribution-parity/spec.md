# Spec: the profile tier reaches the Athena views

- **Intent:** ./intent.md
- **Author:** Claude (AI agent)
- **Accepted-by:** Tim WU
- **Status:** signed-off

## Behaviour

### 1. Precedence, both Athena views

Both server-side SQL paths resolve a project in this order:

1. the **application inference profile** the call was routed through — matched on
   `l.modelId = <profile ARN>`, resolved to the profile's `tums-project` tag value;
2. `requestMetadata['project_id']`, joined to the `project_mapping` CSV for a display name;
3. `'untagged'`.

This is the aggregator's order with the two raw-log-invisible tiers (admin identity hint, one-time
historical attribution) absent. Tier 1 wins over tier 2 whenever both are present, matching the
Fast path exactly, so the two views never disagree about which tier applies.

Two SQL surfaces are in scope because the page uses both:

- **`byProject` in `queries.ts`** — the async template the Projects page's Full toggle actually
  calls (`POST /v1/queries` → poll). This is the query that produced the qa evidence.
- **`/v1/projects` in `projects.ts`** — the synchronous Full path, still reachable and documented.

### 2. The mapping comes from the existing profile cache

The mapping source is the registry's resolved-profile cache (`REGISTRY#PROFILE` items in the
tenants table, written by the aggregator's `resolveUnseenProfiles`, read by `listProfiles()`). It is
inlined into the statement:

- `queries.ts` emits `CASE WHEN l.modelId = '<arn>' THEN '<project id>' END`, with **no `ELSE`**, so
  a call that was not profile-routed yields `NULL` and the enclosing `COALESCE` falls through to
  tier 2. This mirrors the `buildModelExpr` pattern already used to price profile-routed calls.
- `projects.ts` emits `WITH profile_map (profile_arn, project_id) AS (VALUES …)` and left-joins it,
  because that path also needs the profile's project name and cost centre from `project_mapping`.

The fold happens **in the `GROUP BY` key, not afterwards in the Lambda.** Merging profile rows into
project rows after the query would require re-aggregating `COUNT(DISTINCT user_id)` across merged
groups, which over-counts any user who appears in both — the distinct-count cannot be reconstructed
from group totals.

No profile row is mirrored to S3 or Glue: the cache is already authoritative and self-healing (it
negative-caches unknown ARNs for 24 h and re-resolves on tag change), so a mirror would add a
staleness window and a second source of truth.

### 3. Safety and degradation

- Every interpolated ARN and project id is allow-listed before it enters SQL: `queries.ts` reuses
  its `SAFE_SQL_STR` (`^[A-Za-z0-9:._/-]+$` — no quote can pass); `projects.ts` reuses `sanitize()`
  (doubles quotes, then strips anything outside `[\w@.\-:/]`). A value that fails the check is
  dropped from the mapping, not escaped into it.
- `projectId === 'untagged'` and empty ids are excluded, so the tier never asserts a project it does
  not know.
- **Empty mapping ⇒ the pre-change statement, byte for byte.** An empty `VALUES` list is a syntax
  error, and an empty `CASE` is meaningless; with no resolved profiles each path emits exactly the
  SQL it emitted before, one join fewer.
- A cache read that throws logs a warning naming the disabled tier and returns no mapping. The
  query still runs. Attribution degrades; the page does not break.
- The inlined mapping is capped (400 rows) against Athena's 262 kB statement limit. One profile
  exists per project × model, so a few dozen rows is the real shape; the cap only bounds a
  pathological cache, and truncation degrades attribution for the overflow rather than failing the
  query.

### 4. One project, one name

A row attributed by tier 1 is labelled by project **id** when the `project_mapping` CSV has no row
for it. Both Full paths relabel from the project registry, which is the same source Fast uses:

- `projects.ts` relabels its result rows via `listProjects()`. Ids are unique, so this is a pure
  relabel: no rows merge and no aggregate is recomputed.
- `ProjectsPage.tsx` relabels Athena rows from the Fast response it is **already fetching** for the
  authoritative totals — no extra request. The relabel runs **before** `mergeProjectRows`, so a
  project with rows from both tiers collapses into one row instead of appearing twice under two
  labels.

A row whose cost centre is `—` inherits the registry's cost centre; a cost centre resolved by SQL
always wins.

### 5. The page states the real limit

The Projects panel's precedence copy replaces its claim that the divergence is by design with what
is true per tier: Full resolves tiers ① and ②; it cannot resolve ③, and pre-profile history stays
`untagged` there, because an identity hint and the one-time historical treatment exist only as
rollup state and no raw-log field carries them. A larger `untagged` share in Full is therefore
**those two tiers, not lost usage** — stated in that form, so a reader can check it.

### 6. Currency formatting

`fmtUsd` renders thousands separators and exactly two decimals: `$13,858.35`. The locale is
**pinned** to `en-US` rather than left to the browser, because an unpinned locale is the same defect
mirrored — a reader in a comma-decimal locale would see `$13.858,35` for a figure the rest of the
page states in `en-US` form. `fmtSignedUsd` had that latent form of the bug and is pinned with it.

### 7. The bug-fix agent reports results as results

`ci-agent/bugfix_agent.py`:

- **Exit code:** applying zero patches is a *result*, not a tool failure. The script returns 0 after
  writing its summary. Redness for an unfixable finding belongs to the workflow's stall detector
  (two consecutive zero-progress rounds) and its absolute fuse, which also carry the explanatory PR
  comment. A non-zero exit is reserved for a genuine failure of the tool itself.
- **Diff salvage:** `extract_diff` accepts an **unterminated** fence. A max-token stop truncates the
  reply mid-stream, so the closing fence never arrives; requiring it made the advertised salvage
  path dead code for the one failure mode it exists for. A trailing line cut mid-hunk — one not
  starting with a unified-diff marker — is dropped before the patch is returned.
- **Prompt order:** the diff is requested **first**, analysis after, so a truncation loses the
  explanation rather than the payload. The agent is told to emit no diff, and say so in one line,
  when the named file is wrong or the fix is architectural rather than a local edit.

## Out of scope

- The identity-hint and historical tiers in Athena (no raw-log signal exists — see the intent).
- Any new Glue table, S3 export or scheduled mirror of the profile cache.
- Changing what a row sums to: token and cost arithmetic, the per-model rate card, and the
  scaling-to-rollup-totals behaviour are untouched.
- The `guess_source` file-routing heuristic in the bug-fix agent beyond what it already does.
