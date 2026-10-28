# Plan: P1 deploy fixes (mini chain)

- **Spec:** ./spec.md
- **Author:** Claude (AI agent)
- **Accepted-by:** Tim WU
- **Accepted-for:** 88f077dc056dd08c9045ed72050e93e29f2cb2c5
- **Status:** accepted

`Accepted-for` is the tip of `main` after PR #80 (mantle-counts-persisted). Nothing else is in flight.

## Files changed
1. `infra/lib/stacks/lakehouse-stack.ts` — CUR bucket SSE-S3; both Data Exports principals and SourceArn shapes; export depends on the policy.
2. `infra/test/lakehouse-stack.test.ts` — pins the policy, the dependency and the encryption.

Non-source riders: `.sdlc/active` (handover from `mantle-counts-persisted`), `intent/mantle-counts-persisted/*` → shipped,
`intent/lakehouse-p1-deploy-fixes/*`, `docs/LAKEHOUSE.md` (runbook), CHANGELOG line.

## Verification
infra jest 22/22 + tsc; cdk synth (ci); SDLC gate. Live: fourth Lakehouse deploy succeeds after the owner's LF bootstrap.
