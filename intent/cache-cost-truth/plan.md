# Plan: cache-cost truth (feature-37)

- **Spec:** ./spec.md
- **Author:** Claude (AI agent)
- **Accepted-by:** Tim WU
- **Accepted-for:** daf6df698ab7c9ceb44b2444a8af84d699e85a2c
- **Status:** accepted

`Accepted-for` is bound at branch time to the tip of `main` after feature-36 (`cache-write-pricing`) merges; this chain
waits for it because its tests assert feature-36's fields and its copy describes them. Guards, docs and help copy were
built beforehand on `ca0ba29`; the three page files and `overview-calc.ts` are finished after the rebase.

## Files changed
1. `backend/lambdas/api/pricing-completeness.test.ts` — new: every parser token kind is priced (red before feature-36, green after).
2. `backend/lambdas/ingestion/rollup-fields.test.ts` — new: every rollup writer / script carries every counter; all shapes carry the same set.
3. `backend/scripts/check-rate-card.ts` — new: rate card vs AWS Price List, exit 1 on drift or an unpriced kind.
4. `backend/lambdas/api/overview-calc.ts` — `tokensOf` adds `cacheWriteTokens`; `byModel` rows sum `cacheWriteTokens` / `cacheWriteUsd` / `cacheNetUsd`.
5. `backend/lambdas/api/overview-calc.test.ts` — asserts the token figure and the new per-model sums.
6. `frontend/src/pages/CostsPage.tsx` — "Net effect of prompt caching" tile and "Cache net (USD)" column from `cacheNetUsd`; lower-bound footer line.
7. `frontend/src/pages/UsagePage.tsx` — cache copy: reads 0.1×, writes 1.25× / 2×.
8. `frontend/src/pages/OverviewPage.tsx` — Spend definition (four token kinds, lower bound); freshness line with last run.
9. `frontend/src/pages/ProjectsPage.tsx` — note wording; freshness line.
10. `frontend/src/lib/help-content.ts` — entries rewritten/added/removed as in the spec.
11. `frontend/src/api/client.ts` — `OverviewResponse.byModel[].cacheNetUsd?` (optional; the one type the Cost tile reads).
12. `frontend/src/lib/model-names.ts` — an opaque application-inference-profile id is labelled "Inference profile <id>" instead of "Unknown <Id>" (qa F-PR69-004 on #69; the model behind it needs the API's resolution, which the cost endpoints do not yet return).

Non-source riders: `.sdlc/active` (handover from `cache-write-pricing`), `intent/cache-write-pricing/*` → shipped,
`intent/cache-cost-truth/*`, `CHANGELOG.md`, `README.md`, `docs/GOVERNANCE_FAQ.md`, `docs/ROADMAP.md`,
`docs/VERIFICATION.md`, `docs/ARCHITECTURE.md`, `docs/RECONCILIATION.md`, `docs/incidents/2026-10-cache-write-omission.md`,
`docs/test-reports/feature-37-cache-cost-truth.md` + index row, `backend/package.json` + lock (`@aws-sdk/client-pricing`
dev dependency).

## Verification
- `jest`: the two guard suites green on the rebased tree; red on `ca0ba29` for exactly six cases (recorded in the report).
- `npx tsx backend/scripts/check-rate-card.ts` prints zero DRIFT / UNPRICED after feature-36 (the 2026-10-06 run on
  `ca0ba29` showed 20 UNPRICED, 0 DRIFT — recorded).
- frontend `tsc` + `vite build`; SDLC gate dry-run.
- Local authenticated render: no page contains "discount" in a cache context; Cost tile reads a signed net figure equal to
  Σ `cacheNetUsd`; Overview token figure = input + output + cache-read + cache-write of `/v1/overview`; freshness line
  shows both the latest logged call and the last run; 0 console errors.
- Live via qa; expect no finding on the changed copy.

## Risks
- A `cacheNetUsd` field name change in feature-36 breaks the tile — the field contract is fixed in both plans.
- The guard tests read source text; a refactor that renames `upsert*` functions or moves `COUNTERS` must update them (the
  tests fail loudly with "expected index > -1", not silently).
