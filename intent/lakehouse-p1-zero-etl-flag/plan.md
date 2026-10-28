# Plan: zero-ETL behind a flag (mini chain)

- **Spec:** ./spec.md
- **Author:** Claude (AI agent)
- **Accepted-by:** Tim WU
- **Accepted-for:** 4474a20ac429dad355c86054269d7c86e08746aa
- **Status:** shipped

`Accepted-for` is the tip of `main` after PR #81. Nothing else is in flight.

## Files changed
1. `infra/lib/stacks/lakehouse-stack.ts` — zero-ETL block behind `cfg.lakehouse.enableZeroEtl`.
2. `infra/lib/config/types.ts` — the flag.
3. `infra/test/lakehouse-stack.test.ts` — 0 by default / 2 with the flag.

Non-source riders: `.sdlc/active` (handover from `lakehouse-p1-deploy-fixes`), `intent/lakehouse-p1-deploy-fixes/*` → shipped,
`intent/lakehouse-p1-zero-etl-flag/*`, `docs/LAKEHOUSE.md` (zero-ETL marked as flagged follow-up), CHANGELOG line.

## Verification
infra jest + tsc; cdk synth (ci); SDLC gate. Live: fifth Lakehouse deploy completes.
