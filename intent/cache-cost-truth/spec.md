# Spec: cache-cost truth — copy, record, guards

- **Intent:** ./intent.md
- **Author:** Claude (AI agent)
- **Accepted-by:** Tim WU
- **Status:** shipped

Depends on feature-36 (`cache-write-pricing`) being on main: the fields `cacheNetUsd`, `cacheWriteTokens`,
`cacheWriteUsd`, `estimatedUsdUpperBound`, `rollupsLastRunAt` and the counters `cacheWriteTokens` /
`cacheWrite5mTokens` / `cacheWrite1hTokens` on every rollup writer.

## 1. Guards (backend, jest)
- `backend/lambdas/api/pricing-completeness.test.ts` — derives the token kinds from `parse.ts`'s `InvocationRecord`
  (`*TokenCount` fields → `*Tokens`); for each kind not in `UNPRICED_BY_DESIGN` (empty), a count of that kind alone must
  yield `estimatedUsd > 0` on a priced model and on every card row; cache writes must cost ≥ 1.25× input.
- `backend/lambdas/ingestion/rollup-fields.test.ts` — static: each `upsert*` ADD list ⊇ its aggregate's counters;
  `ProjectAggregate` and `ProjectDayAggregate` carry exactly `UsageAggregate`'s token counters; `repair-projday-day.ts`
  `COUNTERS` and `backfill-projday.ts` ADD clauses list every PROJDAY counter.
- Both are red on pre-feature-36 main for exactly the omission and green after it (proven on both trees).

## 2. Drift script
`backend/scripts/check-rate-card.ts` — Price List `AmazonBedrockFoundationModels`, region from `AWS_REGION`, route
`global` (or `--route regional`); model from `servicename`, kind/TTL from `usagetype`; compares every card row that has a
`MODEL_NAMES` entry on input / output / cacheRead / cacheWrite5m / cacheWrite1h; statuses `ok | DRIFT | UNPRICED | NOT IN
LIST`; `--json`; exit 1 on DRIFT or UNPRICED. Dev dependency `@aws-sdk/client-pricing`.

## 3. Copy (frontend)
- `pages/CostsPage.tsx`: tile "Saved by prompt caching" → "Net effect of prompt caching", value `totalCacheNetUsd`
  (signed; negative shown as a cost), help `cost.cache-net`; column "Cache savings (USD)" → "Cache net (USD)" from
  `cacheNetUsd`; footer gains "lower bound (~9 %) until the standard-route correction".
- `pages/UsagePage.tsx`: "billing discounts them" → "reads billed at 0.1×, writes at 1.25× (2× for 1-hour)"; the
  Prompt-cache tile's foot likewise.
- `pages/OverviewPage.tsx`: Spend definition counts input + output + cache-read + cache-write and carries the lower-bound
  note; freshness line "latest logged call HH:MM (N ago) · new logs are rolled up every 15 minutes · last run HH:MM".
- `pages/ProjectsPage.tsx`: "reads and writes are priced but not counted"; freshness wording as Overview.
- `lib/help-content.ts`: `overview.spend`, `usage.input-tokens`, `usage.cache-tokens`, `cost.estimated-spend`,
  `cost.cache-read-tokens` rewritten; `cost.cache-net` and `cost.cache-write-tokens` added; `cost.cache-savings` removed.
- `backend/lambdas/api/overview-calc.ts`: `tokensOf` includes `cacheWriteTokens` so the Spend tile's token figure matches
  its definition; `byModel` rows carry `cacheWriteTokens`/`cacheWriteUsd`/`cacheNetUsd` (summing feature-36's per-item
  values); `spend.tokens` definition documented.

### 3b. Opaque profile ids
`lib/model-names.ts`: a 12-character application-inference-profile id (after ARN stripping) parses to vendor
`inference-profile`, friendly "Inference profile <id>", family `other` — truthful, not a guessed vendor. Resolving it to the
model it routes needs a per-row `resolvedModel` from the cost endpoints (not in this chain).

## 4. Docs
`README.md`, `docs/GOVERNANCE_FAQ.md`, `docs/ROADMAP.md`, `docs/VERIFICATION.md`, `docs/ARCHITECTURE.md` corrected;
`docs/incidents/2026-10-cache-write-omission.md` (RCA) and `docs/RECONCILIATION.md` (payer-account runbook) added;
CHANGELOG "Fixed" entry; test report `docs/test-reports/feature-37-cache-cost-truth.md` + index row.

## Out of scope
Rates, rollup writers, backfill (feature-36); the ×1.1 standard-route correction (own chain); qa agent rules (request to
its owner); CI wiring of the drift script (owner decision on `pricing:GetProducts`).
