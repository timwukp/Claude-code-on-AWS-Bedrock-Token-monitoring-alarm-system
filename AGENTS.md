# AGENTS.md

Guidance for AI coding agents (and humans) working in this repository. This file follows the
[agents.md](https://agents.md) convention.

## What this project is

A cross-industry, multi-tenant platform for monitoring **Amazon Bedrock** token usage, detecting
cost anomalies, automating incident response, and running forensic analytics. AWS-native,
deployable into any AWS account. See `README.md` and `docs/ARCHITECTURE.md`.

## Repository map

| Path | What |
|---|---|
| `infra/` | AWS CDK v2 app (TypeScript). Stacks in `infra/lib/stacks`. Entry: `infra/bin/infra.ts`. |
| `backend/` | Lambda handlers (`lambdas/api`, `lambdas/ingestion`, `lambdas/anomaly-response`, `lambdas/dora` = GitHub collector + DORA math), shared libs (incl. `shared/project-registry` = project↔repo↔cost mapping), Fargate ETL (`analysis/`). |
| `frontend/` | React + Vite SPA (the dashboard). |
| `docs/` | Architecture, Well-Architected review, monitoring approach, attribution, ADRs. |
| `scripts/` | Deploy/setup helpers. |

## Setup, build, test (do this first)

```bash
make install        # installs infra + backend + frontend deps
make test           # backend unit tests (Jest) — must pass
make build          # backend type-check + frontend production build — must pass
```

To validate the infrastructure compiles you need a config file:

```bash
cp infra/lib/config/example.env.json infra/lib/config/dev.json
# edit dev.json: set "account" and "region" (placeholders won't deploy)
make synth ENV=dev  # cdk synth all stacks
```

## Conventions to follow

- **TypeScript strict mode.** No `any` without a comment justifying it.
- **Pure logic, thin handlers.** Put testable logic in pure modules (pattern:
  `backend/lambdas/ingestion/parse.ts`) and keep the AWS-calling handler thin.
- **Infra is code-only** — change AWS resources via CDK stacks, never describe console steps.
- **Add a regression test** for every bug fixed (see `backend/lambdas/api/queries.test.ts`).
- **Never commit secrets or account-specific config.** `infra/lib/config/<env>.json` and
  `cdk.context.json` are gitignored; only `example.env.json` is tracked.

## Validation gates (CI runs these)

1. `cd backend && npm test` — Jest.
2. `cd backend && npx tsc --noEmit` — type-check.
3. `cd frontend && npm run build` — build.
4. `cd infra && npx cdk synth --context env=dev` — synth (needs a `dev.json`).

A change is not "done" until all four pass.

## The CI QA loop's rules (owner decision, 2026-09-21)

`.github/workflows/ui-qa-agent.yml` runs a UI QA agent against the deployed dev site on every
frontend PR, then a Bug-Fix agent that patches and pushes onto the branch, re-triggering the loop.
Three rules govern it. Each exists because its absence caused a specific, repeated failure.

1. **The check's colour must match the report's verdict.** The QA step runs under
   `continue-on-error` — a non-zero exit there must not abort the fix loop — so a terminal step
   reads `overall` back and fails the job when the loop has stopped with an unclean report.
   Without it, PRs #51, #52 and #53 each reached "all checks passed" while their own report said
   `overall: FAIL`. `QA_RED_ON` selects whether LOW findings redden the check (`FAIL`, the default)
   or only blocking ones (`BLOCKING`).
2. **The Bug-Fix agent may only edit files the active intent plan names.** Its check is a mirror of
   `sdlc_ci_gate.py`'s own `plan_covers`, and must stay behaviourally identical: stricter and it
   refuses patches the gate would accept, looser and it pushes patches the gate rejects. A patch
   outside the plan turns the very check the fix was meant to green into a red one — that is what
   needed hand-written reverts on #48 and #51. The commit step stages exactly the agent's own
   patched list, so one list governs both.
3. **A finding that recurs across PRs gets its own intent chain, not another fix round.** A finding
   whose file no active plan names is refused every round, so it survives PR after PR with nobody
   owning it: one `/anomalies` copy defect was reported four times before anyone wrote a chain for
   it. The bot names the recurrence in its summary; acting on it means opening a chain that names
   the file, not waiting for a plan that happens to cover it.

## Deploying (only when explicitly asked)

```bash
make deploy ENV=dev            # cdk deploy --all
make deploy-frontend ENV=dev   # build + publish SPA, invalidate CloudFront
```

Deployment costs money and creates real AWS resources. Don't deploy unless asked. Data buckets
and DynamoDB tables use `RETAIN`; `make destroy` won't delete them (delete manually after review).

## Key domain facts (so you don't re-derive them)

- Bedrock Model Invocation Logs are **newline-delimited JSON**, read with the **OpenX JSON SerDe**.
- Real log records include `identity.arn` (caller IAM), `requestMetadata` (only if the caller
  set it), and prompt-cache token counts. See `docs/VERIFICATION.md` and `docs/ATTRIBUTION.md`.
- Per-user/per-project attribution requires the **calling application** to set
  `requestMetadata={project_id,user_id}` at call time — the monitor cannot add it afterward.
- Bedrock `InvokeModel`/`Converse` are CloudTrail **management events** (on by default) and reach
  EventBridge without a custom trail.
