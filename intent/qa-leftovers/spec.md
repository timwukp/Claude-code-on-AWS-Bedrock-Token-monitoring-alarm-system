# Spec: qa leftovers

- **Intent:** ./intent.md
- **Author:** Claude (AI agent)
- **Accepted-by:** Tim WU
- **Status:** shipped

## Behaviour
1. `frontend/src/lib/format.ts` — `hourAxis(maxHours)` → `{ ticks, domain, tickFormatter }`: ≥ 48 h → ticks at whole-day
   multiples (step 1/2/7/14 days by span), labels `Nd`; below → whole-hour ticks (step 1/2/4/12), labels `Nh`; 0 unlabelled.
   `fmtAxisHours` stays for other callers.
2. `frontend/src/pages/DoraPage.tsx` — the lead-time `YAxis` takes `hourAxis(max medianLeadHours)`.
3. `frontend/src/pages/UsagePage.tsx` — `fillBuckets(points, fromIso, toIso, daily)` emits every hour/day bucket between
   the window bounds with zeros where the API returned nothing; points outside the window are appended, not dropped.
   Applied after `bucketDaily`.
4. `backend/lambdas/api/quotas.ts` — per-model token sums run in one `Promise.all`; `listTokenQuotas` is memoised in
   module scope for 10 minutes (`QUOTA_CACHE_MS`), so warm invocations skip the Service Quotas pages.

## Acceptance
- Frontend `tsc` + `vite build`; the axis helper and the fill helper checked by hand on fixtures (daily 8-day window
  with two populated days → 8 buckets; hourly 03:30→07:10 → 5 buckets).
- `/v1/quotas` live duration before vs after (CloudWatch REPORT): before 6–11 s; target < 2 s warm.
- Served bundle carries the new helpers; qa run on the PR re-verifies F-PR69-003 and F-PR69-007.

5. (qa round 1 on the PR) `roi-calc.ts`: when `perProjectStaffing !== true`, `value.timeSaved` and `investment.training`
   are 0 with "Not computed" notes and no `teamSize` in their formula inputs; `value.totalUsd` excludes them. The
   Projects "Total tokens" tile states it counts input + output tokens only.

## Out of scope
F-PR69-008 (owner ops); F-PR68-003 (already FIXED in #68 round 2).
