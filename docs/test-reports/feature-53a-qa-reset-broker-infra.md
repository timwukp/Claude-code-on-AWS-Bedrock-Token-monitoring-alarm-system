# Feature 53a — the QA reset broker as code: a CDK stack deployed before any workflow calls it

- **Chain:** `intent/qa-reset-broker-infra/` · **Branch:** `feat/qa-reset-broker-infra` off `main@881ddb1` · **Issue:** #133 · **PR:** #134
- **Origin:** feature-53 (WS1), split in two after the commander's review on 2026-11-28. Part 2 is
  [feature-53](./feature-53-qa-run-lock-and-rotation.md).
- **Date:** 2026-11-28
- **Verdict:** PASS offline. The deploy comes after the merge (below) and is recorded in the follow-up

## What this report has to say plainly
- **This part only adds the broker.** The `qa-login-reset` Lambda, its role and the CI role's invoke grant are now a
  CDK stack, `Tums-<env>-QaBroker`. No workflow calls the broker until part 2 merges, so merging and deploying this
  part changes no QA run.
- **Why a separate PR:** part 2 makes every UI QA run use the broker and fail closed without it. Shipping the broker
  first, and deploying it, removes the "merge before deploy" trap. Nobody has to remember to set
  `QA_ROTATION=manual`.
- **Why CDK and not shell commands:** AGENTS.md says to change AWS resources through CDK only. The staged shell
  commands were a second deploy path with no tests; they're now superseded. The one role outside this app (the
  harness execution role's Deny on `locks/*`) stays a staged owner command.
- **Deploying it doesn't touch AuthStack.** The stack takes the pool ID from the pool-ARN export AuthStack already
  has. The deployed `Tums-dev-Auth` exports exactly that one name, and the synthesised AuthStack still exports only it.

## Changes
| File | Change |
|---|---|
| `infra/lib/stacks/qa-broker-stack.ts` | The stack: the function, `qa-login-reset-role` (IAM package item 2) and `QaResetBrokerInvoke` on the CI role (item 3) |
| `infra/bin/infra.ts`, `infra/lib/config/types.ts`, `ci.json`, `example.env.json` | `qaBroker` in the env file (CI role name, the two logins); the stack is synthesised only when it is set |
| `infra/test/qa-broker-stack.test.ts`, `infra/test/synth.ts`, `infra/test/security.test.ts` | Every action and resource pinned; the asset is exactly four files; the stack joins the "no write action on `*`" invariant |
| `ci-agent/harness_lock_spec.json`, `harness_lock.py`, `test_harness_lock.py` | The lease module the broker reads the lease with, and its tests (moved out of `test_agents.py`, plus 8 new state-file tests) |
| `ci-agent/qa_reset_broker_spec.json`, `qa_reset_broker.py`, `test_broker.py` | The broker; on exit it now drops both references to the password (review note 3) |
| `scripts/verify-qa-broker.sh` | Read-only post-deploy check: 10 IAM simulations, the function's state, a no-lease probe |
| `.github/workflows/ci.yml` | Runs `test_broker` and `test_harness_lock` with `test_agents` |

## Red (each new test fails before the change)
| Run on `main@881ddb1` | Result |
|---|---|
| `python3 -m unittest test_broker test_harness_lock` | 2 errors: `ModuleNotFoundError` for `qa_reset_broker` and `harness_lock` |
| `npx jest test/qa-broker-stack.test.ts` | Suite fails: TS2307, `../lib/stacks/qa-broker-stack` doesn't exist |

## Green
| Gate | Result |
|---|---|
| `python3 -m unittest test_agents test_broker test_harness_lock`, Python 3.12.12 and 3.14.7 | 93 of 93 on both |
| `npm run build && npm test` in `infra/` | 68 of 68 (54 existing + 14 new) |
| `npx cdk synth --context env=ci` (the CI command, backend deps installed) | 12 stacks, including `Tums-ci-QaBroker` |
| SDLC gate, `--require-active`, against `881ddb1` | Refuses as drafted (no acceptance yet); passes with the acceptance simulated in a scratch copy |

## Mutation
| Set | Result |
|---|---|
| `harness_lock.py`, 28 mutants (acquire, takeover, renew, time-based loss, release, the state file, `HeldLease`), judged by `test_harness_lock` + `test_broker` only | 28 of 28 killed |
| `qa-broker-stack.ts`, 17 mutants: a grant widened to `*`, an extra action, a wider secret or lease ARN, no SourceAccount, a renamed function or role, all of `ci-agent/` shipped, usernames dropped, no log retention, an empty or partial `logins` accepted, a literal pool ID, the pool ID through a new Auth export | 17 of 17 killed |

**A measurement fault, caught and fixed.** The first stack run reported 0 of 15 killed. `npm run build` had left
compiled `.js` files next to the sources, and jest resolves `x.js` before `x.ts`, so every test ran the stale build.
Each mutant is now compiled (`tsc`) before jest runs.

## Deploy (after merge; the owner, each step after the commander's ACK)
Not yet run. In order (`deploy/RUNBOOK-feature53.md` in the working notes):
1. Add the `qaBroker` block to the untracked `infra/lib/config/dev.json` (the two logins' secret names and usernames).
2. `npx cdk diff Tums-dev-QaBroker --exclusively --context env=dev`. The diff must list only the new stack: no
   `Tums-dev-Auth` change.
3. `npx cdk deploy Tums-dev-QaBroker --exclusively --context env=dev`.
4. `./scripts/verify-qa-broker.sh dev`: 10 IAM decisions as expected, the function Active, the probe answers
   `no-lease`.
