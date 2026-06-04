# Contributing

Thanks for your interest in improving the Token Usage Monitoring System.

## Project layout

```
docs/        Architecture, Well-Architected review, monitoring approach, attribution, ADRs
infra/       AWS CDK app (TypeScript) — all stacks
backend/     Lambda handlers + shared libs + Fargate ETL
frontend/    React + Vite dashboard SPA
scripts/     bootstrap / deploy / teardown helpers
```

## Prerequisites

- Node.js 20+, npm
- AWS CDK v2 (`npm i -g aws-cdk`)
- Docker (for the Fargate ETL image; Lambda bundling uses local esbuild)
- An AWS account + credentials for deploying

## Setup

```bash
make install      # install infra, backend, frontend deps
make test         # run unit tests
make synth        # cdk synth all stacks (requires infra/lib/config/<env>.json)
```

See `make help` for all targets.

## Development workflow

1. Create a branch from `main`.
2. Make your change with matching tests.
3. Run `make test` and `make synth` — both must pass.
4. Keep the style of the surrounding code (TypeScript strict mode is on).
5. Open a merge/pull request describing the change and how you validated it.

## Coding conventions

- TypeScript strict mode; no `any` unless unavoidable and commented.
- Lambda business logic should be **pure and unit-testable** where possible
  (see `backend/lambdas/ingestion/parse.ts` as the pattern), with the AWS-calling handler thin.
- Infrastructure changes go through CDK only — no console click-ops.
- Never commit secrets, account IDs, or environment config. `infra/lib/config/<env>.json` and
  `cdk.context.json` are gitignored; only `example.env.json` is tracked.

## Tests

- Backend: `cd backend && npm test` (Jest).
- Infra: `cd infra && npm run synth` validates the CDK app compiles and synthesizes.
- Add a regression test for any bug you fix.

## Reporting issues

Please include: what you expected, what happened, the stack/region, and relevant log output
(with any sensitive values redacted).
