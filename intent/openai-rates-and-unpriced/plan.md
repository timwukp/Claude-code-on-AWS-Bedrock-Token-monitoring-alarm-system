# Plan: OpenAI rates and unpriced models (feature-41)

- **Spec:** ./spec.md
- **Author:** Claude (AI agent)
- **Accepted-by:** Tim WU
- **Accepted-for:** dc60133947c71692db298676bfec99e147b06cd6
- **Status:** shipped

`Accepted-for` is the tip of `main` after PR #73 (mantle-visibility, feature-40); the only chain in flight (the peer's
chain B waits for this one, per the owner's one-chain rule).

## Files changed
1. `backend/lambdas/api/cost-calc.ts`, `backend/lambdas/api/cost-calc.test.ts`, `backend/lambdas/api/cost-calc-openai.test.ts`,
   `backend/lambdas/api/pricing-completeness.test.ts`
2. `backend/lambdas/api/queries.ts`, `backend/lambdas/api/queries.test.ts`, `backend/lambdas/api/projects-sql.test.ts`
3. `backend/lambdas/api/costs.ts`, `backend/lambdas/api/projects.ts`
4. `backend/lambdas/api/overview-calc.ts`, `backend/lambdas/api/overview-calc.test.ts`
5. `backend/lambdas/api/bill-calc.ts`, `backend/lambdas/api/bill-calc.test.ts`
6. `backend/lambdas/ingestion/parse.ts`, `backend/lambdas/ingestion/parse-attribution.test.ts`
7. `frontend/src/api/client.ts`, `frontend/src/components/UnpricedNote.tsx` (new), `frontend/src/pages/CostsPage.tsx`,
   `frontend/src/pages/OverviewPage.tsx`, `frontend/src/pages/ProjectsPage.tsx`, `frontend/src/pages/GovernancePage.tsx`,
   `frontend/src/pages/SettingsPage.tsx`, `frontend/src/lib/help-content.ts`
8. Docs: `docs/VERIFICATION.md`, `docs/RECONCILIATION.md`, `docs/research-openai-pricing-sources.md` (new),
   `CHANGELOG.md`, `docs/test-reports/feature-41-openai-rates-and-unpriced.md` (new), `docs/test-reports/README.md`
9. SDLC: `intent/openai-rates-and-unpriced/intent.md`, `intent/openai-rates-and-unpriced/spec.md`,
   `intent/openai-rates-and-unpriced/plan.md`, `.sdlc/active`, `intent/mantle-visibility/intent.md`,
   `intent/mantle-visibility/spec.md`, `intent/mantle-visibility/plan.md` (→ shipped)

## Order
card + matchRate + SQL order (tests updated for the new rates / order) → unpricedModels on the three readers →
billedZero in the bill block → role-prefix hints → frontend → docs → gates → live check → push → PR → qa → owner deploys
Api (code only; Etl for the aggregator's `parse.ts` change — identity hints apply at ingest) → owner merge.

## Verification
Backend `npx jest` + `tsc --noEmit -p .`; frontend `tsc --noEmit` + `vite build`; `cdk synth -c env=ci`; this gate;
leak scan; `scripts/check-rate-card.ts` (Claude rows); local run of the three handlers against the real tables under the
owner's claims — gpt-5.6-sol ≈ $103, identical `unpricedModels` on all three; after the Api deploy, the same from the
deployed functions; served bundle grep for "unpriced" and "billed $0".

## Risks
- The owner's all-time Cost total rises ≈ $56 (gpt-5.6-sol 3.2× correction) for usage AWS billed $0 — stated in the
  test report and the bill panel (`billedZero` once the collector covers August; it starts at 10-01 today).
- Long-context OpenAI calls (> 272K input) are under-estimated (2× input, 1.5× output on the cards); the rollups cannot
  tell them apart. Stated in VERIFICATION.
- Identity hints now cover roles: an admin who hinted a role expecting one session's attribution now attributes all
  sessions — the intended behaviour, called out in the Settings placeholder.
