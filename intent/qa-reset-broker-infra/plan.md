# Plan: the QA reset broker as code (feature-53, part 1 of 2)

- **Spec:** ./spec.md
- **Author:** Claude (AI agent)
- **Accepted-by:** Tim WU (2026-11-28, in the session that built it)
- **Accepted-for:** 881ddb15983f5adbcbe535006ebf9e614deb97b0
- **Status:** accepted

## Files changed
1. Lease module: `ci-agent/harness_lock_spec.json`, `ci-agent/harness_lock.py`, `ci-agent/test_harness_lock.py`
2. Broker: `ci-agent/qa_reset_broker_spec.json`, `ci-agent/qa_reset_broker.py`, `ci-agent/test_broker.py`
3. CDK:
   - `infra/lib/stacks/qa-broker-stack.ts`, `infra/bin/infra.ts`
   - `infra/lib/config/types.ts`, `infra/lib/config/ci.json`, `infra/lib/config/example.env.json`
   - `infra/test/qa-broker-stack.test.ts`, `infra/test/synth.ts`, `infra/test/security.test.ts`
4. CI and the post-deploy check: `.github/workflows/ci.yml`, `scripts/verify-qa-broker.sh`
5. Docs: `CHANGELOG.md`, `docs/test-reports/feature-53a-qa-reset-broker-infra.md` (new), `docs/test-reports/README.md`
6. SDLC:
   - `intent/qa-reset-broker-infra/intent.md`, `intent/qa-reset-broker-infra/spec.md`,
     `intent/qa-reset-broker-infra/plan.md`
   - `.sdlc/active` (handover from `qa-prompt-matches-skill`)
   - `intent/qa-prompt-matches-skill/intent.md`, `intent/qa-prompt-matches-skill/spec.md`,
     `intent/qa-prompt-matches-skill/plan.md` (→ shipped; landed as #132)

## Order
1. Offline: spec → red → green → mutate.
2. Issue → branch → push (Git Data API) → PR. This PR doesn't touch `ui-qa-agent.yml` or `frontend/`, so it starts no
   QA run.
3. Merge (the owner), then the owner:
   1. adds `qaBroker` to the untracked `infra/lib/config/dev.json`;
   2. runs `cdk deploy Tums-dev-QaBroker --exclusively`, after the commander's ACK;
   3. runs `scripts/verify-qa-broker.sh`.
4. Then the next chain: `intent/qa-run-lock-and-rotation`.

## Risks
- **A second writer on the CI role.** The QA session's change to `GitHubActionsUITestRole` (trust + narrowing) must keep
  the CDK-owned `QaResetBrokerInvoke` policy. Both sides are named in the runbook, and `verify` simulates the invoke.
- **A deploy that would touch AuthStack.** Avoided: the stack imports only the pool-ARN export AuthStack already has (a
  test pins that).
