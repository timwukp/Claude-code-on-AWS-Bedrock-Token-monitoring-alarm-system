# Plan: hardening 2 — limits and visibility (feature-49)

- **Spec:** ./spec.md
- **Author:** Claude (AI agent)
- **Accepted-by:** Tim WU
- **Accepted-for:** 2b99397b421ab25b32b448bfebad7c083b3dc073
- **Status:** shipped

`Accepted-for` is the tip of `main` after PR #112 (lakehouse-p2-silver). Chain 2 of the owner-approved hardening
programme (plan-mode approval 2026-10-28). Opened after the peer's P2 PR per the one-chain rule; rebased if P2 merges first.

## Files changed
1. Infra: `infra/lib/stacks/api-stack.ts`, `infra/lib/stacks/data-stack.ts`, `infra/lib/stacks/etl-stack.ts`,
   `infra/lib/stacks/automation-stack.ts`, `infra/lib/stacks/dora-stack.ts`, `infra/lib/stacks/auth-stack.ts`,
   `infra/lib/stacks/frontend-stack.ts`, `infra/lib/config/types.ts`, `infra/bin/infra.ts`, `infra/test/synth.ts`,
   `infra/test/security.test.ts`
2. Backend: `backend/lambdas/anomaly-response/containment.ts`, `backend/lambdas/anomaly-response/containment.test.ts`,
   `backend/lambdas/anomaly-response/index.ts`, `backend/lambdas/api/usage.ts`, `backend/lambdas/api/usage-range.test.ts` (new),
   `backend/lambdas/api/project-registry.ts`, `backend/lambdas/shared/project-registry.ts`, `backend/lambdas/shared/project-registry.test.ts`,
   `backend/lambdas/api/dora.ts`
3. Frontend: `frontend/src/api/client.ts`, `frontend/src/pages/SettingsPage.tsx`
4. CI: `.github/workflows/sdlc-gate.yml`
5. Docs: `CHANGELOG.md`, `docs/test-reports/feature-49-hardening-2-limits-and-visibility.md` (new), `docs/test-reports/README.md`,
   `SECURITY.md`
6. SDLC: `intent/hardening-2-limits-and-visibility/intent.md`, `intent/hardening-2-limits-and-visibility/spec.md`,
   `intent/hardening-2-limits-and-visibility/plan.md`, `.sdlc/active`, `intent/lakehouse-p2-silver/intent.md`,
   `intent/lakehouse-p2-silver/spec.md`, `intent/lakehouse-p2-silver/plan.md` (→ shipped; #112 already shipped `ci-dependabot-tamed`)

## Order
limits (API/Athena/usage) → registry redaction + caps → retention/log groups/alarms/CloudFront logs → gate from base →
containment rewrite → invariants → docs → gates → push → PR → qa → owner deploys Data (lifecycle), Automation (env, alarm,
log group), Auth (alarm), Dora (log group), Etl (log groups, alarms), Api (stage settings, access log, log groups, alarm,
code), Frontend (log bucket + logging) → live checks → merge.

## Verification
Backend jest + tsc; frontend tsc + build; infra jest (45) + synth; actionlint; SDLC gate; leak scan. Live per the spec.

## Risks
- Stage throttling at 20 rps is far above the dashboard's real rate (a page load is ~6 calls); the per-method 2 rps on
  `POST /v1/queries` could 429 a user who hammers "Run" — the UI debounces, and 429 is the right answer there.
- New log groups for existing functions: CloudFormation creates the group and switches the function to it; old
  `/aws/lambda/<fn>` groups stay (and still never expire) until deleted by hand — listed in the deploy note.
- CloudFront logging requires the log bucket to allow ACLs; it is a dedicated bucket, S3-managed encryption, 90-day expiry.
- The containment counter adds one UpdateItem per AccessDenied event when enforcement is ON (off in dev).
