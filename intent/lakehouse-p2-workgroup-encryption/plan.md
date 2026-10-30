# Plan: workgroup without explicit result encryption (mini chain)

- **Spec:** ./spec.md
- **Author:** Claude (AI agent)
- **Accepted-by:** Tim WU
- **Accepted-for:** 7c06d3efe82fced66aa68c743bb6e4878f8fba8f
- **Status:** accepted

`Accepted-for` is the tip of `main` after PR #114. Nothing else is in flight.

## Files changed
1. `infra/lib/stacks/lakehouse-silver.ts` — no encryptionConfiguration on the lakehouse workgroup.
2. `infra/test/lakehouse-stack.test.ts` — asserts it.

## Full file list (every changed non-doc file, for the CI gate)
- `infra/lib/stacks/lakehouse-silver.ts`
- `infra/test/lakehouse-stack.test.ts`

Non-source riders: `.sdlc/active` (handover from `lakehouse-p2-athena-workgroup`), `intent/lakehouse-p2-athena-workgroup/*` → shipped,
`intent/lakehouse-p2-workgroup-encryption/*`, `docs/LAKEHOUSE.md`, CHANGELOG line.

## Verification
infra jest 54/54 + tsc; cdk synth (ci); SDLC gate. Live: Lakehouse redeploy; RegistrySnapshotFn, DimModelRefreshFn and LakehouseSilverSfn succeed; verify-lakehouse.ts.
