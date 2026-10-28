# Plan: Firehose fixes (mini chain)

- **Spec:** ./spec.md
- **Author:** Claude (AI agent)
- **Accepted-by:** Tim WU
- **Accepted-for:** b2851fe9a4bad0750906800b054b62ed96f9fa2e
- **Status:** accepted

`Accepted-for` is the tip of `main` after PR #82. Nothing else is in flight.

## Files changed
1. `infra/lib/stacks/lakehouse-stack.ts` — Lambda-only processors; federated-catalog Glue resources.
2. `infra/test/lakehouse-stack.test.ts` — processor assertion updated; Glue resource test.

Non-source riders: `.sdlc/active` (handover from `lakehouse-p1-zero-etl-flag`), `intent/lakehouse-p1-zero-etl-flag/*` → shipped,
`intent/lakehouse-p1-firehose-fixes/*`, CHANGELOG line.

## Verification
infra jest 23/23 + tsc; cdk synth (ci); SDLC gate. Live: sixth Lakehouse deploy completes.
