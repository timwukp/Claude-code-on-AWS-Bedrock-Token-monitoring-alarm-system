# Intent: the QA reset broker as code — a CDK stack, deployed before any workflow calls it

- **Slug:** qa-reset-broker-infra
- **Author:** Claude (AI agent)
- **Date:** 2026-11-28
- **Accepted-by:** Tim WU (2026-11-28, in the session that built it)
- **Status:** accepted

## Problem
- **Per-run QA passwords need a broker that exists before the workflow calls it.** The workflow change
  (`intent/qa-run-lock-and-rotation`) defaults every UI QA run to the broker and fails closed without it. If it merged
  first, every QA run would turn red.
- **The broker was staged as shell commands.** AGENTS.md says to change AWS resources through CDK stacks only. A
  script that creates a role and a Lambda is a second deploy path with no tests, and it drifts from the repo.

## Desired outcome
- **`Tums-<env>-QaBroker`, a CDK stack the owner deploys before the workflow change merges.** It holds:
  - the `qa-login-reset` Lambda;
  - its role, with IAM package item 2 exactly;
  - the CI role's one invoke grant, IAM package item 3.
- **CDK assertion tests pin every action and resource.** A widened grant fails `npm test` before it reaches an account.
- **The Lambda ships exactly four files:** the broker, the lease module it reads the lease with, and their two specs.
  These files land here with their own tests (`test_broker`, `test_harness_lock`).
- **Nothing calls the broker yet.** Merging and deploying this changes no QA run.

## Non-goals
- The workflow and `qa_agent.py` using the lease and the broker. That's the next chain,
  `intent/qa-run-lock-and-rotation`.
- Roles outside this app:
  - the harness execution role's Deny on `locks/*`: a staged owner command;
  - the Ops Console role's lock grant: the commander's ops-console repo.
- The optional EventBridge backstop: a separate yes from the owner.
