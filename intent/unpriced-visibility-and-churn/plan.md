# Plan: unpriced visibility, cache churn, one bill panel (feature-42)

- **Spec:** ./spec.md
- **Author:** Claude (AI agent)
- **Accepted-by:** Tim WU
- **Accepted-for:** c087abbecc4261f6a6e55f2ed3325585352ae2f8
- **Status:** accepted

`Accepted-for` is the tip of `main` after PR #76 (lakehouse P0), rebound on 2026-10-24 when #76 merged ahead of this
chain. Nothing else is in flight.

## Files changed
1. `backend/lambdas/api/projects.ts` — fast rows: `cacheReadTokens`, `cacheWriteTokens`, `cacheWriteShare`.
2. `backend/lambdas/api/overview-calc.ts` — movers: the same three fields, current window only.
3. `backend/lambdas/api/overview-calc.test.ts` — movers cache-share cases.
4. `backend/lambdas/api/pricing-completeness.test.ts` — `CACHE_WRITE_FREE` for the post-#74 card.
5. `backend/scripts/check-rate-card.ts` — first-party price-list reader; OpenAI servicenames; 30-minute TTL mirror; `NOT_IN_LIST_OK`; stricter exit.
6. `frontend/src/api/client.ts` — movers churn fields.
7. `frontend/src/pages/CostsPage.tsx` — merged bill panel; "unpriced" badge; `billedTo` wording.
8. `frontend/src/pages/OverviewPage.tsx` — Cache churn column; unpriced status chip; unlogged suffix.
9. `frontend/src/pages/ProjectsPage.tsx` — Cache churn column; scan-running caption.
10. `frontend/src/pages/DoraPage.tsx` — pluralised counts.
11. `frontend/src/main.tsx` — NotFoundPage route.
12. `frontend/src/lib/help-content.ts` — `cost.unpriced`, `cost.mantle` (rewritten), `project.cache-churn`.
13. `frontend/src/styles.css` — `.notice` styles.

Non-source riders: `.sdlc/active` (handover from `lakehouse-p0-stabilise`), `intent/lakehouse-p0-stabilise/*` → shipped,
`intent/openai-rates-and-unpriced/*` → shipped, `intent/unpriced-visibility-and-churn/*`, `CHANGELOG.md`, `docs/incidents/2026-10-cache-write-omission.md`
(service-name correction), `docs/test-reports/feature-42-unpriced-visibility-and-churn.md` + index row.

## Verification
- backend `jest` (42 incl. the three guard suites) + `tsc`; frontend `tsc` + `vite build`; SDLC gate dry-run.
- `check-rate-card.ts` live: OK — Astra and gpt-oss compared to the cent; five card-sourced rows allow-listed; no DRIFT.
- Local authenticated render: Cost shows one bill panel (no duplicate), "unpriced" badge only on unpriced rows; Projects and
  Overview show Cache churn with values in [0, 100 %] or "—"; `/does-not-exist` renders the not-found page with its own
  title; DORA strings read "1 day" / "7 days"; 0 console errors.
- After the owner-authorised Api deploy (OverviewFn + ProjectsFn code): `/v1/projects?source=fast` rows carry
  `cacheWriteShare`; Overview movers carry it; the churn columns fill.

## Risks
- Churn values need the Api deploy; until then the columns read "—" by design.
- The bill panel's account-vs-tenant framing is the peer's; this chain only widens the columns — if `tenantLoggedEstimateUsd`
  is absent the desc omits that clause.
