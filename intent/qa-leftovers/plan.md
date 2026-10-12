# Plan: qa leftovers (feature-39)

- **Spec:** ./spec.md
- **Author:** Claude (AI agent)
- **Accepted-by:** Tim WU
- **Accepted-for:** bc366b3e5732265322e3fd5bbd04aa48c349b7a0
- **Status:** accepted

`Accepted-for` is the tip of `main` after PR #71 (standard-route, feature-38) merged; the only chain in flight.

## Files changed
1. `frontend/src/lib/format.ts` — `hourAxis`.
2. `frontend/src/pages/DoraPage.tsx` — lead-time axis uses it.
3. `frontend/src/pages/UsagePage.tsx` — `fillBuckets` applied to the series.
4. `backend/lambdas/api/quotas.ts` — per-model sums in two `GetMetricData` calls; 10-minute quota-list cache.
5. `infra/lib/stacks/api-stack.ts` — `cloudwatch:GetMetricData` added to QuotasFn's read-only CloudWatch statement
   (the deployed first cut 500'd on AccessDenied: a local run under my own credentials had masked the missing action).

Non-source riders: `.sdlc/active` (handover from `standard-route`), `intent/standard-route/*` → shipped,
`intent/qa-leftovers/*`, `CHANGELOG.md`, `docs/test-reports/feature-39-qa-leftovers.md` plus its index row.

## Order
feat → gates → owner deploys `Tums-dev-Api` (QuotasFn only) → measure the live duration → frontend deploy →
served-bundle check → report → PR.

## Verification
Gates; hand-checked helper fixtures; live QuotasFn durations from CloudWatch before and after; qa's re-verification of
F-PR69-003/007 on the PR.

## Risks
- Zero-filled rows appear in the Usage table (by design: a quiet day is information).
- The quota cache is per Lambda container; a quota change shows within ten minutes or on a cold start.
