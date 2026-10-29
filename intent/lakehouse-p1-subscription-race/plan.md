# Plan: inline PutRecord permissions (mini chain)

- **Spec:** ./spec.md
- **Author:** Claude (AI agent)
- **Accepted-by:** Tim WU
- **Accepted-for:** de51b8a9a9107a1494da52a3f453b771fcd1bac4
- **Status:** accepted

`Accepted-for` is the tip of `main` after PR #83. #84 (peer) is open and will rebase after this.

## Files changed
1. `infra/lib/stacks/lakehouse-stack.ts` — inline policies; explicit dependencies.
2. `infra/test/lakehouse-stack.test.ts` — pins both.

Non-source riders: `.sdlc/active` (handover from `lakehouse-p1-firehose-fixes`), `intent/lakehouse-p1-firehose-fixes/*` → shipped,
`intent/lakehouse-p1-subscription-race/*`, CHANGELOG line.

## Verification
infra jest 24/24 + tsc; cdk synth (ci); SDLC gate. Live: seventh Lakehouse deploy completes.
