# Plan: dedicated lakehouse workgroup (mini chain)

- **Spec:** ./spec.md
- **Author:** Claude (AI agent)
- **Accepted-by:** Tim WU
- **Accepted-for:** e6f1de647f0a362a330aa273efcd2cd47022f940
- **Status:** shipped

`Accepted-for` is the tip of `main` after PR #113 (hardening-2). Nothing else is in flight.

## Files changed
1. `infra/lib/stacks/lakehouse-silver.ts` — workgroup; jobs/SFN/Lambdas use it.
2. `infra/test/lakehouse-stack.test.ts` — pins it.
3. `scripts/verify-lakehouse.ts` — default workgroup.
4. `scripts/lakehouse-smoke.ts` — default workgroup.

## Full file list (every changed non-doc file, for the CI gate)
- `infra/lib/stacks/lakehouse-silver.ts`
- `infra/test/lakehouse-stack.test.ts`
- `scripts/verify-lakehouse.ts`
- `scripts/lakehouse-smoke.ts`

Non-source riders: `.sdlc/active` (handover from `hardening-2-limits-and-visibility`), `intent/hardening-2-limits-and-visibility/*` → shipped,
`intent/lakehouse-p2-athena-workgroup/*`, `docs/LAKEHOUSE.md` (runbook item), CHANGELOG line.

## Verification
infra jest 47/47 + tsc; cdk synth (ci); SDLC gate. Live: Lakehouse redeploy; RegistrySnapshotFn/DimModelRefreshFn succeed; silver SFN run SUCCEEDED; verify-lakehouse.ts.
