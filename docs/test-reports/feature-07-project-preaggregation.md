# Test Report — Feature #7: Per-project pre-aggregation (DynamoDB)

| | |
|---|---|
| Issue | #7 |
| Branch | `feat/project-preaggregation` |
| Date | 2026-06-05 |
| Environment | Real AWS account, `us-east-1` |
| Result | **PASS** — unit + real-AWS end-to-end |

## Scope

The By-Project view ran an Athena query per request. Pre-aggregate per-project usage in the
scheduled aggregator (write `TENANT#<tenant>#PROJECT` items) so `/v1/projects?source=fast` reads
DynamoDB instead — faster and cheaper at scale.

## Implementation

- `backend/lambdas/ingestion/parse.ts` — pure `projectOf` (project_id tag or `untagged`) and
  `aggregateByProject` (fold per tenant+project+model; de-dup by requestId; union distinct
  `user_id` for a user count).
- `backend/lambdas/ingestion/aggregator.ts` — accumulate + `mergeProjects` + `upsertProjectRollup`
  (`pk=TENANT#<tenant>#PROJECT`, `sk=<projectId>#<modelId>`, with a `userSet` string set).
- `backend/lambdas/api/projects.ts` — `?source=fast` path reads the PROJECT rollups from DynamoDB,
  sums across models per project, applies the rate card; the default Athena path (CSV name JOIN)
  is unchanged.
- `infra` — `tables.aggregates.grantReadData(projectsFn)`.

## Unit tests

`cd backend && npm test` → **57 passed** (added 5 to `parse.test.ts`): project tag derivation;
group-by tenant+project+model with token sums; distinct-user count; idempotency (duplicate
requestIds not double-counted); untagged rollup.

## Build / synth gates

`tsc --noEmit` (backend) PASS; `cdk synth env=ci` PASS.

## Real-AWS end-to-end validation

1. Ran the aggregator against the real raw-log bucket → wrote PROJECT rollups to
   `tums-aggregates-dev`. Verified in DynamoDB: `proj-alpha/bravo/charlie` (synthetic tagged
   demo data) + `untagged` (real Claude Code traffic, no project tag), with correct token/call
   counts and idempotent re-runs.
2. `GET /v1/projects?source=fast` (real Cognito JWT) returned `source: dynamodb` with:
   - proj-bravo 415,000 tokens / 2 users / $11.63
   - proj-alpha 157,000 / 2 users / $4.49
   - proj-charlie 38,000 / 1 user / $1.04
   - untagged 306,951 / $79.83 (real traffic)
   Response ~1.8s incl. network (DynamoDB read itself single-digit ms) vs the multi-second Athena
   start-and-poll path.

## Verdict

All gates green; pre-aggregation validated against real data; fast path returns correct rollups
from DynamoDB without an Athena scan. Ready for review.
