# Intent: make the security alerts we already write reachable by the feed built to show them

- **Slug:** anomaly-key-shape
- **Author:** Claude (AI agent)
- **Date:** 2026-09-18
- **Accepted-by:** Tim WU
- **Status:** accepted

## Problem

The anomalies table has one reader and, until this chain, two independent writers that disagreed
with it about the shape of its own primary key.

| Component | `pk` written / queried | `sk` written / queried |
|---|---|---|
| `backend/lambdas/anomaly-response/index.ts` (writer) | `TENANT#<tenant>#ANOMALY` | `<eventTime>#<type>#<sourceIp>` |
| `backend/lambdas/api/anomalies.ts` (the only reader, `GET /v1/anomalies`) | `TENANT#<tenant>` | `begins_with(sk, 'ANOMALY#')` |

**Both halves of the key mismatched.** The partition key carried a `#ANOMALY` suffix the reader
never asks for, and the sort key carried no `ANOMALY#` prefix for the reader to match. So every
security alert that Lambda ever wrote — the ones raised for denied access and for off-hours usage —
was present in the table and unreachable from the feed that exists to display it.

Nothing in the stack could report this. A DynamoDB `PutItem` with a wrong key is not a wrong key to
DynamoDB: it is a new item, and it succeeds. A `Query` whose key condition matches nothing is not an
error either: it returns an empty page, which is exactly what "no anomalies detected" looks like. The
failure mode is therefore an empty security feed that reads as good news, in a product whose whole
claim is that it can see what is happening.

The third call site, `backend/lambdas/ingestion/aggregator.ts` (runaway-spend anomalies, added by
feature-14), happened to write the **correct** shape — but by a duplicated string literal, not by a
shared definition. Two writers spelling one key out separately is how the first drift happened; the
second writer being accidentally right is not a control.

## Desired outcome

- One definition of the anomalies key shape, used by every writer and by the reader, so the
  writer/reader agreement is a property of the code rather than of three independent spellings.
- The alerts already sitting in the table on the unreadable shape become readable, rather than being
  written off as history — an alert that was raised is evidence, and deleting it is not a fix.
- The key stays deterministic, so a re-processed batch re-puts the same item instead of duplicating
  an alert into the feed.
- The sort order the reader already relies on is preserved deliberately rather than by luck: the
  timestamp leads the sort key, so lexicographic order is chronological order and
  `ScanIndexForward: false` yields newest-first with no secondary index.

## Non-goals

- No new table, index or GSI. The single-partition-per-tenant query is the right shape; it was only
  ever being asked the wrong question.
- No change to anomaly **detection** — what counts as an anomaly, its thresholds, or its severity.
  This chain changes where an anomaly is stored, not whether it is raised.
- No change to the `/v1/anomalies` response contract or the page that renders it. The endpoint was
  already correct; it will simply stop returning nothing.
- No permanent migration tooling. Repairing the legacy shape is a one-off, and a script that lives on
  invites a second key shape to live on with it.

## Rider: a cumulative token total that reads as a typo

`fmtTokens` in `frontend/src/lib/format.ts` stopped scaling at `M` and applied no digit grouping, so
a cumulative total rendered as `16215.23M` — a figure a reader has to decode rather than read. It has
been reported by the UI QA agent more than once and belongs to no other open plan. It rides here
because this is the next chain to touch that file, and it is named in the plan so the gate can see it.
