# Plan: anomaly table key-shape drift (feature-22)

- **Spec:** ./spec.md
- **Author:** Claude (AI agent)
- **Accepted-by:** Tim WU
- **Accepted-for:** 4ea7eb88c2907d0bd9b5a410c81a153803c7c5a0
- **Status:** accepted

`Accepted-for` is the current tip of `main`, which is this branch's merge base — the value the sdlc
gate compares against `git merge-base origin/main HEAD`. This chain is stacked on nothing: the defect
pre-dates every open branch and lives in files no other open plan names, so it lands on its own chain
off `main`.

The branch was cut at `de81fb7` (post-#48); #49 then landed and edited three of the same meta files —
`.sdlc/active`, `CHANGELOG.md` and the test-report index — leaving the pull request conflicting, and a
conflicting PR has no mergeable ref for GitHub to build, so not one check could start. `main` was
therefore **merged in** rather than the branch rebased: history already published under an open PR is
not rewritten. That makes `4ea7eb8` an ancestor, so it is now both the merge base and this chain's
`Accepted-for`. #49 also retired `global-time-range` itself, so the chain this one hands over from is
`projects-roi-followups`.

## Files changed

### Backend — the shared key definition
1. `backend/lambdas/shared/anomaly-key.ts` — **new.** The single definition of the anomalies key
   shape: `ANOMALY_SK_PREFIX`, `anomalyPk(tenantId)`, `anomalySk(detectedAt, type, discriminator)`.
   `detectedAt` leads the sort key so lexicographic order is chronological, which is what makes the
   reader's existing `ScanIndexForward: false` newest-first without a secondary index. Also exports
   the legacy-repair vocabulary — `AnomalyTableItem`, `tenantOf(pk)`, `targetKeys(item)` — because
   recognising the old shape is key-shape knowledge and belongs beside the key, not in a script. The
   docblock records the drift itself, so the next reader learns why the module exists.
2. `backend/lambdas/shared/anomaly-key.test.ts` — **new.** 16 cases: the `pk` carries no `#ANOMALY`
   suffix; the `sk` always carries the prefix and `detectedAt` leads it; two keys sort
   chronologically as strings; the same input twice yields the same key (so a re-processed batch
   re-puts rather than duplicates); `tenantOf` recovers the tenant from both shapes and returns
   `null` for a non-anomaly partition; `targetKeys` returns `null` for a conforming item, rewrites
   when **either** half is wrong, prefers the `detectedAt`/`type` attributes over re-parsing the
   legacy sort key, and tolerates a discriminator containing `#`.

### Backend — the three call sites, which must agree
3. `backend/lambdas/anomaly-response/index.ts` — the writer that was unreachable. Replaces
   `pk = TENANT#<tenant>#ANOMALY` and the bare `<eventTime>#<type>#<sourceIp>` sort key with
   `anomalyPk()` / `anomalySk()`. A comment states what the old shape cost, so the fix is not
   mistaken for a refactor.
4. `backend/lambdas/api/anomalies.ts` — the only reader (`GET /v1/anomalies`). Its key condition is
   already correct and does not change in behaviour; it now builds `:pk` and `:skPrefix` from
   `anomalyPk()` and `ANOMALY_SK_PREFIX` so the reader and the writers cannot drift apart again.
5. `backend/lambdas/ingestion/aggregator.ts` — the runaway-spend writer (feature-14). It was
   accidentally correct, via a duplicated literal. Switched to the shared helpers: a third spelling
   of the key is the hazard that produced this defect, whatever value it currently holds.

### Backend — repairing the rows already written
6. `backend/scripts/migrate-anomaly-keys.ts` — **new, one-off.** Scans the anomalies table, applies
   `targetKeys`, and prints the plan. **Dry run by default; `--apply` is required to write.** Each
   replacement is `Put` under `attribute_not_exists(pk)`, and the legacy row is deleted only after
   the replacement is confirmed — so a crash mid-item leaves a duplicate the next run cleans, never a
   lost alert. Conforming items are counted and skipped, which makes a clean re-run the proof.

### Frontend
7. `frontend/src/lib/format.ts` — `fmtTokens` gains the tiers above `M` and pinned `en-US` grouping,
   closing the recurring QA finding where a cumulative total rendered as `16215.23M`. This is the only
   line of this chain in the frontend; it touches no component and no API type.

### Non-source riders
`.sdlc/active` → `anomaly-key-shape` (pointer handover) · `intent/projects-roi-followups/*` → shipped
(all three files together — the gate reads the ladder, so retiring only `intent.md` fails as "a stage
was skipped") · `intent/anomaly-key-shape/*` (this chain) · `CHANGELOG.md` ·
`docs/test-reports/feature-22-anomaly-key-shape.md` plus its index row in `docs/test-reports/README.md`.

## Commit order

1. `docs(sdlc)`: this chain + the `.sdlc/active` handover.
2. `fix(anomalies)`: `backend/lambdas/shared/anomaly-key.ts` + its test file, and the three call
   sites (`anomaly-response/index.ts`, `api/anomalies.ts`, `ingestion/aggregator.ts`). The writers,
   the reader and the definition move in **one** commit: a commit that fixes one side and not the
   other is a commit whose deployed state is still broken, in a different direction.
3. `chore(scripts)`: `backend/scripts/migrate-anomaly-keys.ts`.
4. **Deploy the anomaly Lambdas and the API, run the migration dry-run, then `--apply`, then
   re-verify against the reader's own key condition — before pushing 1–3.** New writes must be on the
   new shape before the old rows are moved onto it; otherwise the migration races a writer still
   producing legacy keys.
5. `fix(frontend)`: `frontend/src/lib/format.ts`. Deploy the frontend, invalidate CloudFront, push.
6. `docs`: CHANGELOG + test report + index row; open the PR.

## Verification

- **Gates before any push:** backend `jest` (194/194 across 20 suites, including the 16 new cases) +
  `tsc --noEmit`; frontend `tsc --noEmit` + `vite build`; `cdk synth -c env=ci`; `sdlc_ci_gate.py`
  dry-run with every changed source file named above and `Accepted-for` equal to
  `git merge-base origin/main HEAD`.
- **Live (dev), on `tums-anomalies-dev` — the load-bearing evidence, because no test can prove a key
  shape matches a table's contents.** Recorded and reproducible:
  - Before: 3 items in the table, `0 already readable, 3 to rewrite` — two AccessDenied alerts and
    one OffHoursUsage alert, i.e. every alert ever written was invisible to the feed.
  - Apply: `3 migrated`.
  - After: querying with **the reader's own key condition** returns 1 item for one tenant and 2 for
    the other, and a second dry run reports `3 already readable, 0 to rewrite`.
  - The re-run is part of the evidence, not a formality: it is what distinguishes "migrated" from
    "migrated and still conforming".
- **Determinism check:** unit-tested directly (an identical input yields an identical key), and
  confirmed at the table by the clean re-run above — a second pass over the same rows adds nothing.
- **F-1201-class rider:** assert a value above `1e12` renders with a `T` tier and digit grouping, and
  that no page shows a figure of the `16215.23M` form.
- **Leak-scan every push:** no 12-digit account ids, no ARNs, no key material, no customer names.
- Recorded in `docs/test-reports/feature-22-anomaly-key-shape.md`.

## Risks

- **The defect class is silence, and silence is what we are testing for.** DynamoDB accepts a wrong
  key and returns nothing for a mismatched query, so no assertion inside a Lambda could have caught
  this and none will catch the next one. The structural mitigation is that the key now has exactly one
  definition; the behavioural one is that the live check queries with the *reader's* key condition
  rather than a hand-written one, so a future drift fails the check that matters.
- **The migration writes to a table holding security evidence.** It is dry-run by default, conditional
  on `attribute_not_exists(pk)`, and deletes only after a confirmed write. The residual failure mode
  is a duplicate alert, which is visible and cleanable; a lost alert would not be.
- **Legacy sort keys are parsed defensively but were never validated on write.** `targetKeys` prefers
  the item's `detectedAt` and `type` attributes precisely because a discriminator may contain `#`. An
  item missing both attribute and parsable segment is rewritten with an explicit `unknown` marker
  rather than dropped — a mislabelled alert is recoverable, a deleted one is not.
- **The migration is one-off and must not become infrastructure.** Standing tooling for the broken
  shape keeps the broken shape alive; the script exists to be run once and then to stop being run.
- **`frontend/src/lib/format.ts` is a contested file.** The compact-number fix was also scheduled by
  the latency chain (feature-18); it ships here because this chain lands first, and that chain's plan
  must drop it rather than both editing the same function. Coordinated, not assumed.
