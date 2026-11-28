# Spec: the QA reset broker as code

- **Intent:** ./intent.md
- **Author:** Claude (AI agent)
- **Accepted-by:** Tim WU (2026-11-28, in the session that built it)
- **Status:** signed-off

## Behaviour
1. `ci-agent/harness_lock_spec.json` and `ci-agent/harness_lock.py` define the lease's format and rules.
   - `HarnessLock` acquires with IfNoneMatch, and takes over an expired or unreadable lease with IfMatch on the ETag
     it read.
   - It renews and releases only on its own ETag.
   - `is_lost()` is true after a 412, 409 or 404, or after `ttlSeconds - clockSkewSeconds` with no successful renewal.
   - The state-file helpers and `HeldLease` (read by the next chain) are here too, so the Lambda's copy of this module
     never changes when that chain lands.
2. `ci-agent/qa_reset_broker_spec.json` and `ci-agent/qa_reset_broker.py`:
   - `handle()` follows the spec's `checkOrder`, `writeOrder` and `passwordPolicy`.
   - It returns `{ok, versionId}`, or `{ok: false, error}` with an error from the spec's list.
   - The password never reaches a response, log, exception or trace. On exit, the handler drops both references to
     it (the string and the secret body).
3. `infra/lib/stacks/qa-broker-stack.ts` (`Tums-<env>-QaBroker`, synthesised only when the env file sets `qaBroker`):
   - **Function:** `qa-login-reset`, python3.12, handler `qa_reset_broker.lambda_handler`, 30 s, its own log group
     (90 days). The code asset is exactly the four files named in `BROKER_FILES`.
   - **Environment:**
     - `QA_BROKER_USER_POOL_ID`: derived from AuthStack's existing pool-ARN export, so AuthStack doesn't change;
     - `QA_BROKER_LOCK_BUCKET`: default `token-monitor-qa-reports-<account>`;
     - `QA_BROKER_SECRET_MAP`: from `qaBroker.logins`, whose usernames live in the untracked env file.
   - **Role `qa-login-reset-role`:** trusts Lambda with `aws:SourceAccount`, and has no managed policies. It may:
     - `cognito-idp:AdminSetUserPassword` and `AdminUserGlobalSignOut` on the pool;
     - `secretsmanager:GetSecretValue`, `PutSecretValue` and `UpdateSecretVersionStage` on `<name>-??????` for each
       login;
     - `s3:GetObject` on `<bucket>/locks/ui-harness.json`, a key read from the lock spec;
     - write its own log group.
   - **The CI role** (`qaBroker.ciRoleName`) gets one named policy, `QaResetBrokerInvoke`: `lambda:InvokeFunction` on
     this function.
4. `scripts/verify-qa-broker.sh` is the read-only post-deploy check: IAM simulation for both roles, the function's
   state, and a no-lease probe. A jest test pins its names to the stack's.
5. `.github/workflows/ci.yml` runs `test_broker` and `test_harness_lock` with `test_agents`.

## Acceptance
- **Unit:** `python3 -m unittest test_agents test_broker test_harness_lock` on Python 3.12 and 3.14.
- **CDK:** `npm test` in `infra/` (every `QaBrokerStack` assertion plus the existing suites), and `npx cdk synth
  --context env=ci`.
- **Mutation:** every `harness_lock.py` mutant is killed by `test_harness_lock` + `test_broker` alone, and every stack
  mutant by the jest suites.
- **SDLC gate** against the merge base.
- **After the owner's `cdk deploy`** (read-only, `scripts/verify-qa-broker.sh`):
  - IAM simulation gives the expected decision for each action;
  - the function is Active;
  - a probe with a runId that holds no lease answers `no-lease` (no writes, no sign-in).
