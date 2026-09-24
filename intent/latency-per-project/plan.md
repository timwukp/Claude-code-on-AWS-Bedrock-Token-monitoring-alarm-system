# Plan: latency per project (feature-28, ROADMAP row 13 phase 1b)

- **Spec:** ./spec.md
- **Author:** Claude (AI agent)
- **Accepted-by:** Tim WU
- **Accepted-for:** e47da9b92d4609f4ce79ac44c7b4c91757edd829
- **Status:** accepted

`Accepted-for` is bound to `e47da9b9` — the tip of `main` after #59 (roi-diagram-layout) merged, itself after
feature-27 (#57). This branch was deliberately cut after both, under the owner's rule that two chains never fly at once (the three
rider files and the `.sdlc/active` handover are structurally sequential). The code was built and
gate-tested offline against `91bb02a` while feature-27 was in flight; nothing feature-27 touches is
in this file set.

## Files changed

### Ingestion (pure + writers)
1. `backend/lambdas/ingestion/parse.ts` — `InvocationRecord.output.outputBodyJson?` + `latency?`;
   `LatencySample`, `latencyOf()`; `LATENCY_BUCKET_EDGES_MS`, `LatencyStats`, `emptyLatencyStats`,
   `bucketIndex`, `foldLatency`, `mergeLatency`, `percentileFromBuckets`; `parseLogFile` extracts then
   deletes the body; all three aggregates gain `latency` and fold it.
2. `backend/lambdas/ingestion/parse-latency.test.ts` — 20 cases: real-record shape, non-streaming
   object, null cases, extract-then-discard, bucket edges, separate populations, additive merge,
   percentile interpolation / cumulative walk / open-ended lower edge, all three aggregates de-duped.
3. `backend/lambdas/ingestion/latency-ddb.ts` — `latencyAddClause` (flat attributes, touched buckets
   only, placeholders disjoint from the writers'), `latencyFromItem`, `latencyOnlyAdd`.
4. `backend/lambdas/ingestion/latency-ddb.test.ts` — 7 cases incl. round-trip and "ADD twice == merge".
5. `backend/lambdas/ingestion/aggregator.ts` — three merges call `mergeLatency`; the four `ADD` writers
   (usage, model, project, projday) append the latency clause and values.

### Backfill
6. `backend/scripts/backfill-latency.ts` — guarded, dry-run-by-default, `BACKFILL_UNTIL` required,
   per-object claim/done markers, latency-only ADDs, bodies discarded per object.

### API
7. `backend/lambdas/api/latency-projects.ts` — `buildProjectLatencyRows`, `latencyCoverage` (pure).
8. `backend/lambdas/api/latency-projects.test.ts` — 5 cases.
9. `backend/lambdas/api/latency.ts` — `queryProjdayRaw` (tenant-scoped, `projdayRange`), `projects`
   section in the payload, header and `scopeNote` rewritten.

### Infra
10. `infra/lib/stacks/api-stack.ts` — `tables.tenants.grantReadData(latencyFn)`,
    `tables.aggregates.grantReadData(latencyFn)`, with the reason in a comment. No new routes.

### Frontend
11. `frontend/src/api/client.ts` — `ProjectLatencyFigure`, `ProjectLatencyRow`, `LatencyProjects`;
    `LatencyResponse.projects`.
12. `frontend/src/pages/LatencyPage.tsx` — "By project" panel with the `lower bound` badge and `≥`.

### Docs and chain riders
13. `docs/ROADMAP.md` row 13 — per-project now measured; 🟡 remains only for Athena parity.
14. `CHANGELOG.md`; `docs/test-reports/feature-28-latency-per-project.md` + index row;
    `intent/latency-per-project/*`; `.sdlc/active` → `latency-per-project`; `intent/roi-diagram-layout/*` → shipped (cost-windowing was flipped by #59).

## Deploy order (owner authorisation required for each stack)
1. `cdk diff` then `cdk deploy Tums-dev-Etl` (aggregator) — **record the deploy time**: it is
   `BACKFILL_UNTIL`.
2. `cdk diff` then `cdk deploy Tums-dev-Api` (LatencyFn + two grants).
3. `backfill-latency.ts` dry run → review counts → `--apply`.
4. Live-validate by direct invoke of `LatencyFn` with the real tenant claim: `projects.rows` non-empty,
   coverage pct stated, one project's p50 within its bucket span of a hand-computed value from the
   PROJDAY attributes. Then push the frontend commit (ui-qa ordering).

## Verification
Gates: backend jest (254 → 254+ on this tree already; 32 new cases) + tsc; frontend tsc + vite build;
`cdk synth env=ci`; `sdlc_ci_gate.py --require-active` with every source file above named here.
Leak-scan every push. Live section of the report filled from the direct invokes.

## Risks
- **Estimates, not measurements.** Bucket percentiles are exact only to the bucket span, and the top
  bucket is a lower bound. The payload and page say so on every figure (`estimated`, `openEnded`, `≥`).
- **Coverage is partial by nature.** Calls logged without a body, and rollups older than the
  backfill's reach, carry no sample. Coverage is reported as a share of invocations, never hidden.
- **The backfill has a cut-off it cannot verify itself.** `BACKFILL_UNTIL` must be the Etl deploy
  time; too late double-counts, too early under-counts. The plan records the timestamp.
- **First deploy of the Etl stack mints a new task-definition revision** (schedule-driven, not a
  running service — verified on #50's deploy); the aggregator Lambda swaps code in place.
