# Feature 22 — Anomaly table key-shape drift (one key definition, and the rows already written)

- **Chain:** `intent/anomaly-key-shape/` · base `main@de81fb7` (the chain's `Accepted-for`, and its
  merge base) · **PR:** TBD
- **Origin:** the anomalies feed had never shown an alert, and nothing reported that. Read as
  "no anomalies detected". The `fmtTokens` rider closes **F-1201**, a QA finding that had recurred
  five further times and belonged to no other open plan.
- **Date:** 2026-09-18
- **Verdict:** PASS — gates below, and the live before/after on the dev table, which is the part that
  matters here.

## Two things this report has to say plainly

1. **The defect class is silence.** A DynamoDB `PutItem` with the wrong key is not an error — it is a
   new item, and it succeeds. A `Query` whose key condition matches nothing is not an error either —
   it returns an empty page, which is indistinguishable from a quiet week. No assertion inside a
   Lambda could have caught this and none will catch the next one. The structural mitigation is that
   the key now has exactly **one** definition; the behavioural one is that the live check below
   queries with the *reader's own* key condition rather than a hand-written one.
2. **The verification stopped at the API/table layer.** The Anomalies page was **not** read in a
   browser this round. What is proven is that the reader's key condition now returns the items; that
   the page renders them is inference from unchanged code, not an observation.

## What was wrong

| Component | `pk` written / queried | `sk` written / queried |
|---|---|---|
| `backend/lambdas/anomaly-response/index.ts` (writer) | `TENANT#<tenant>#ANOMALY` | `<eventTime>#<type>#<sourceIp>` |
| `backend/lambdas/api/anomalies.ts` (the only reader, `GET /v1/anomalies`) | `TENANT#<tenant>` | `begins_with(sk, 'ANOMALY#')` |

**Both halves mismatched.** The partition key carried a `#ANOMALY` suffix the reader never asks for,
and the sort key carried no `ANOMALY#` prefix for the reader to match on. So every security alert
that Lambda ever wrote was stored, and unreachable from the feed built to display it.

The third call site, `backend/lambdas/ingestion/aggregator.ts` (the feature-14 runaway-spend writer),
happened to write the **correct** shape — but via a duplicated string literal, not a shared
definition. Two writers spelling one key out separately is how the first drift happened; the second
writer being accidentally right is not a control.

## Fix

- **`backend/lambdas/shared/anomaly-key.ts` — new, and the single definition of the key.** Exports
  `ANOMALY_SK_PREFIX`, `anomalyPk()` and `anomalySk()`, plus the legacy-repair vocabulary
  (`AnomalyTableItem`, `tenantOf`, `targetKeys`) — recognising the old shape is key-shape knowledge
  and belongs beside the key, not in a script.
- **All three call sites now import it**: the two writers (`anomaly-response/index.ts`,
  `ingestion/aggregator.ts`) and the reader (`api/anomalies.ts`). The aggregator was switched even
  though it was already correct: a third independent spelling of the key is the hazard that produced
  the defect, whatever value it currently holds.
- **`detectedAt` leads the sort key**, so lexicographic order is chronological order — which is the
  only reason the reader's existing `ScanIndexForward: false` returns newest-first with no secondary
  index. Asserted in the tests rather than left to review.
- **Keys are deterministic.** Identical input yields an identical key, so a re-processed batch re-puts
  one item instead of appending a duplicate alert to a security feed.
- The reader's key condition, its `ScanIndexForward: false`, the `/v1/anomalies` response contract and
  the page that consumes it are unchanged. This chain makes the existing query find the existing
  items; it does not redefine either.

### One-off migration — `backend/scripts/migrate-anomaly-keys.ts`

**Dry run by default; `--apply` is required to write.** Each replacement is a `Put` under
`attribute_not_exists(pk)`, and the legacy row is deleted **only after** the replacement is confirmed
written. A crash mid-run therefore leaves a duplicate — visible and cleanable — rather than a lost
alert. Conforming items are counted and skipped, which is what makes a clean re-run the proof.

## Rider: `fmtTokens`

`frontend/src/lib/format.ts` — `fmtTokens` now scales past `M` to `B` and `T`, with a pinned `en-US`
locale for grouping. This closes F-1201, where a cumulative cache-read token total rendered as
`16215.23M`: four digits of mantissa with no thousands separator. The locale is pinned rather than
left to the browser for the same reason it is pinned in `fmtUsd` — an unpinned locale is the same
defect mirrored.

## Unit tests / gates

Run on a clean export of `main` with only this change applied.

| Gate | Result |
|---|---|
| backend `jest` | **194 / 194**, 20 suites (`main` alone is 178 across 19; the new suite is the 16 cases) |
| backend `tsc --noEmit` | exit 0 |
| frontend `tsc --noEmit` | exit 0 |
| frontend `vite build` | succeeded |
| `cdk synth --context env=ci` | succeeded, all 10 stacks synthesized |
| leak scan | 12 changed files: no 12-digit account ids, no ARNs, no key material, no customer names |

The new suite was confirmed **collected**, not silently skipped — for a defect whose signature is a
green run that proves nothing, "the tests pass" and "the tests ran" are different claims.

## Live validation — `tums-anomalies-dev` (dev, real data)

This is the load-bearing part of the report: no unit test can prove a key shape matches a real
table's contents.

| Step | Result |
|---|---|
| Before (dry run) | `scanned 3 item(s): 0 already readable, 3 to rewrite` |
| Apply | `done: 3 migrated, 0 were already migrated, 0 untouched.` |
| After, via the reader's own key condition | one tenant returns 1 item, the other returns 2 — **3 of 3 readable** |
| Idempotency (second dry run) | `scanned 3 item(s): 3 already readable, 0 to rewrite` |

The three items were two `AccessDenied` alerts and one `OffHoursUsage` alert — i.e. **every alert the
table held was invisible to the feed**. These are the same three items the feature-14 cleanup recorded
as "3 unrelated anomalies untouched"; they had never been visible.

The "after" check was run with the reader's own key condition — `pk = :p AND begins_with(sk, :s)` with
`:s = 'ANOMALY#'` and `--no-scan-index-forward` — deliberately, not with a hand-written query that
happens to match. A future drift then fails the check that matters.

The re-run is evidence, not a formality: it is what distinguishes "migrated" from "migrated and still
conforming". Both affected tenants are IAM user principals; they are not named here.

## Known gaps

- **The browser render of the Anomalies page was not read this round.** Verification was at the
  API/table layer, via the reader's key condition.
- **The migration is one-off and must not become standing tooling.** Standing tooling for a broken
  shape keeps the broken shape alive; the script exists to be run once and then to stop being run.
- **The class of defect is silence.** No assertion inside a Lambda could have caught it and none will
  catch the next one. The mitigation is structural — the key has exactly one definition — not a test.
- **The fixed code was not deployed to dev, and the migration ran ahead of it — the reverse of the
  order this chain's plan specifies.** `cdk diff` was taken and is clean (three Lambda code updates —
  `AnomaliesFn`, `AnomalyResponseFn`, `AggregatorFn` — plus a new ETL task-definition revision, with
  **no** IAM, table or index change), but the deploy itself was not run. Two consequences, both
  bounded: the repaired rows are already readable, because the reader's key condition was never the
  broken half; and until `AnomalyResponseFn` is redeployed, a security event firing in dev would write
  one more legacy-shape row. That is self-healing — re-running the migration's dry run reports it and
  `--apply` repairs it — but it means `0 to rewrite` is a statement about now, not a guarantee, and it
  should be re-checked immediately after the deploy.

## Leak scan

`grep -nE '[0-9]{12}|AKIA|arn:aws'` over every file in this PR: no matches. No tenant principal, and
no account id, appears in this report; where an ARN shape is needed anywhere in this chain the account
segment is written `ACCOUNT_ID`.
