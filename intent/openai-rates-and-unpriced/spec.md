# Spec: OpenAI rates and unpriced models

- **Intent:** ./intent.md
- **Author:** Claude (AI agent)
- **Accepted-by:** Tim WU
- **Status:** shipped

## Behaviour
1. `backend/lambdas/api/cost-calc.ts` — `matchRate(id, card)` returns the row whose key is the longest substring of `id`
   (`ZERO_RATE` when none); `cardByKeyLength(card)` for SQL; `isPriced(id)`; `UnpricedModel`; `collectUnpriced(rows)`
   (normalized id, merged, zero-usage dropped, largest first); `TokenCounts.invocations?`; `CostSummary.unpricedModels`.
   Rows: `gpt(key, inPerMTok, outPerMTok)` helper → gpt-5.6-luna 0.20/1.20, gpt-5.6-sol 4/20, gpt-5.6-terra 2/12,
   gpt-6-astra 10/50, gpt-6-luna 0.10/0.50, gpt-6-sol 2/10 (cache read 0.1×, both cache-write columns 1.25×, two tiers);
   gpt-oss-120b 0.15/0.60 and gpt-oss-20b 0.07/0.30 (one tier, cache 0). The `gpt-5` row is removed.
2. `backend/lambdas/api/queries.ts` — `rateCase` iterates `cardByKeyLength(RATE_CARD)`.
3. `backend/lambdas/api/costs.ts`, `projects.ts` (`modelTotals`) — rows carry `invocations`; responses carry
   `unpricedModels`. `costs.ts` `hasUsage` ignores `invocations` (qa F-PR69-006 stays true).
4. `backend/lambdas/api/overview-calc.ts` — `OverviewResult.unpricedModels` from the current-window `byModel` rows.
5. `backend/lambdas/api/bill-calc.ts` — `BillModelRow.billedZero?` (billed < $0.005 and logged ≥ $0.005),
   `BillBlock.billedZeroEstimateUsd`, `loggedSharePct = Σ min(billed_m, logged_m) / Σ billed`; note extended.
6. `backend/lambdas/ingestion/parse.ts` — `identityHintKeys(arn)` → [session, session-less assumed-role, IAM role] for
   `arn:<p>:sts::<12 digits>:assumed-role/<role>/<session>`, else [arn]; all lower-cased, role path never guessed;
   `lookupIdentityHint`; `deriveProject` tier 3 uses it.
7. Frontend — `UnpricedModel` type; `unpricedModels?` on overview / costs / projects; `billedZero?`,
   `billedZeroEstimateUsd?` on the bill types; `components/UnpricedNote.tsx` (badge "unpriced", list with tokens and
   calls, how to fix) under Spend by model (Cost), the Overview footer, the Projects table (fast); bill panel badge
   "billed $0" + sentence; Governance KPI foot / Overview budget tile / `budget.actual` help: budget = three Bedrock
   services MTD incl. today, bill panel = model usage through the last billed day; Settings identity-ARN placeholder
   and Projects attribution text mention the role rule.

## Acceptance
- Unit: longest-key on a reversed card gives the same rows; every card figure above asserted per model; no `gpt-5`
  LIKE in the SQL; SQL tests longer keys first; `collectUnpriced` merges ARN and bare forms and drops zero rows;
  `billedZero` flagged and summed without touching billed / unlogged / share; share 48.3 on the fixture (per-model cap);
  role-hint keys and precedence (exact session > role; other account's same-named role ≠ match).
- Live (owner tenant, new code against the real tables): three endpoints return the same `unpricedModels`;
  gpt-5.6-sol prices ≈ $103 (×1.1); drift script green for the Claude rows.
- Gates: jest, tsc, vite build, cdk synth, sdlc gate, leak scan.

## Out of scope
Long-context OpenAI rates; Mantle token pricing; the Athena (Full) `/v1/projects` path's unpriced list (it prices in
SQL; the Fast path carries the list); tenant keying by role (backlog).
