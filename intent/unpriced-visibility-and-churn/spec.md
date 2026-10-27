# Spec: unpriced visibility, cache churn, one bill panel

- **Intent:** ./intent.md
- **Author:** Claude (AI agent)
- **Accepted-by:** Tim WU
- **Status:** shipped

## 1. Cache churn (feature-42)
- `GET /v1/projects?source=fast` rows gain `cacheReadTokens`, `cacheWriteTokens`, `cacheWriteShare` (writes ÷ (reads +
  writes), 3 dp, null when both 0) — `projects.ts fastProjects` accumulator.
- `GET /v1/overview` `movers[]` gain the same three fields — `overview-calc.ts`, summed over the current window only.
- By project table: column "Cache churn" (percent; `—` with an aria-label when null or in the Athena view; ≥ 50 % in the
  warn colour). Overview "What changed": same column. Help `project.cache-churn`.

## 2. Bill panel (one, on Cost)
- Title "Account bill vs all tenants' logged estimate"; desc states ACCOUNT-WIDE scope and this tenant's logged estimate when
  the API provides it. Columns: Model · Billed · Logged estimate (with "billed $0" badge when `billedZero`) · Not logged ·
  Mantle inferences · Mantle tokens. Row badge "estimate above bill" when `overEstimated`. Total row with "N % of the bill
  is logged". Footer: `billedZeroEstimateUsd` sentence when > 0; "Bill <billedFrom> → <billedTo> (N billed days …)"; the
  CloudWatch-counts-never-multiplied note. Empty state when `byModel` is empty; the panel is absent when `bill` is null.
- Overview Spend tile definition appends "+ $X billed but not logged (bedrock-mantle; Cost Explorer; not included)" when
  `bill.totalUnloggedUsd > 0`.
- Help `cost.mantle` rewritten around the subtraction.

## 3. Unpriced models
- Cost table: Est. cost cell shows an "unpriced" badge for rows whose ids are in `unpricedModels`. Overview Spend tile: warn
  status chip "N unpriced models" (takes precedence over "partial history") and a definition suffix with the excluded token
  count. The peer's `UnpricedNote` stays as the detailed list. Help `cost.unpriced`.

## 4. Drift script
- `MODEL_NAMES` gains `gpt-6-astra → "OpenAI GPT-6 Astra"`; the Marketplace reader accepts `OpenAI …` servicenames and maps
  `cache_write_tokens_30m` to both TTL columns (single TTL); `long_ctx` rows are skipped.
- New first-party reader (`AmazonBedrock`, attribute `model`, "1K tokens" units): Nova Micro, gpt-oss-120b, gpt-oss-20b.
- `NOT_IN_LIST_OK` allow-list with source + date (mythos, mythos-5-1, gpt-5.6-luna/sol/terra, gpt-6-luna/sol); any other
  NOT IN LIST fails, except a cache kind the list does not sell when the card prices it at 0.

## 5. qa leftovers
- `main.tsx`: `*` renders `NotFoundPage` (EmptyState, "No page at <path>", link to Overview) inside the shell with its own
  title; no redirect.
- `ProjectsPage.tsx`: while `loading`, the Full-view "Projects tracked" foot says the scan is running instead of counting rows.
- `DoraPage.tsx`: `plural()` on day/merge/PR/repository/project counts.

## 6. Guards
`pricing-completeness.test.ts` `CACHE_WRITE_FREE` = nova-micro, gpt-oss-120b, gpt-oss-20b with the published reason; the
"names only rows that exist" check keeps the list honest when rows are renamed. `overview-calc.test.ts` asserts the movers'
cache share (0.75 / 0.1 / null) and that prior-window cache traffic is excluded.

## Out of scope
`UnpricedNote.tsx`, `LatencyPage.tsx`, rollups, rates, RECONCILIATION.md (rewritten in #73).
