# Test Report — Features #4 + #5: Budget Action hard-stop + per-project real-time enforcement

| | |
|---|---|
| Issues | #4, #5 |
| Branch | `feat/budget-action-enforcement` |
| Date | 2026-06-05 |
| Environment | Real AWS account, `us-east-1` (enforcement OFF — zero IAM risk) |
| Result | **PASS** — unit + real-AWS deploy; live freeze pending (deliberately not triggered) |

## Scope

Cost-control hard stops, both **opt-in** and **off by default** (Security pillar):
- **#4 Budget Action hard-stop** — when Bedrock spend reaches a configured % of the monthly
  budget, AWS Budgets applies a restrictive deny-Bedrock IAM policy (a real spend-cap freeze).
- **#5 Per-principal real-time enforcement** — the anomaly-response Lambda can attach the same
  deny policy to an offending IAM principal on AccessDenied, scoped and allow-list-guarded.

## Implementation

- `infra/lib/config/types.ts` — optional `enforcement` block (`budgetActionThresholdPct`,
  `budgetActionRoleArns`). Enforcement activates only when `enableAutoContainment` is true AND
  these are set.
- `infra/lib/stacks/automation-stack.ts` — shared deny-Bedrock `ManagedPolicy`; `CfnBudgetsAction`
  (APPLY_IAM_POLICY, AUTOMATIC) + a Budgets execution role; scoped `iam:AttachRolePolicy/
  AttachUserPolicy` grant to the Lambda (conditioned on the deny policy ARN). All created **only**
  when enforcement is enabled.
- `backend/lambdas/anomaly-response/containment.ts` — pure decision logic: parses role/user/STS
  ARNs; refuses to act when disabled, when the principal is allow-listed (no self-lockout), or
  when the ARN is unparseable.
- `backend/lambdas/anomaly-response/index.ts` — replaced the TODO with guarded containment that
  attaches the deny policy and records a `Contained` / `ContainmentFailed` anomaly; failures are
  alerted, never thrown.

## Unit tests

`cd backend && npm test` → **54 passed / 54** (added `containment.test.ts`, 8 tests): ARN parsing
(role/user/assumed-role/invalid), disabled → no-op, allow-listed → no-op, unparseable → no-op,
valid+enabled → acts on the right target.

## Build / synth gates

- `tsc --noEmit` (backend) → PASS
- `cdk synth --context env=ci` (enforcement off) → PASS
- Synth with enforcement ON (temp config) → BudgetsAction + deny policy generated (2 resources)
- Synth with enforcement OFF → **0** enforcement resources (verified — safe default)

## Real-AWS validation

Deployed `Tums-dev-Automation` with **enforcement OFF** (dev.json `enableAutoContainment:false`).
Invoked the Lambda with an AccessDenied event; logs confirm:
- `CRITICAL: …user/test-actor got AccessDenied …` (alert raised)
- `Containment skipped: auto-containment disabled (notify-only)` (correct no-op — no IAM change)

## Deliberately pending (per risk decision)

Per the agreed zero-IAM-risk approach, the **live freeze was not triggered** — that would require
creating a throwaway test IAM role to be frozen. The policy generation and deploy paths are
validated; triggering an actual freeze against an isolated test role is a follow-up if desired.

## Verdict

Both controls implemented, unit-tested, and deploy-validated with enforcement safely off. Live
hard-stop freeze intentionally not exercised (no test victim role created). Ready for review.
