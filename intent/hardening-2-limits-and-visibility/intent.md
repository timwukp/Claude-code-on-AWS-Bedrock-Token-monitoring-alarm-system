# Intent: hardening 2 — limits that bound cost, visibility that catches failure, a hard-stop that targets the right role

- **Slug:** hardening-2-limits-and-visibility
- **Author:** Claude (AI agent)
- **Date:** 2026-10-30
- **Accepted-by:** Tim WU
- **Status:** shipped

## Problem
The 2026-10-28 security audit left, after chain 1, a set of Medium/High items that share a theme: the platform had no
ceilings and little visibility. Any authenticated viewer could start unlimited Athena scans (no API throttling, no
bytes-scanned cutoff); `/v1/usage` accepted any window; the account-wide registry returned identity ARNs (with the
account id) and admin e-mails to every tenant; the versioned raw-log bucket kept deleted objects forever despite a
365-day "retention"; Lambda logs never expired; no alarm fired on Lambda errors, API 5XX or sign-in throttling; CloudFront
had no viewer logs; the SDLC gate graded a PR with the PR's own copy of the gate script; and the auto-containment Lambda
compared CloudTrail *session* ARNs against *role* ARNs and received the same list as "never contain" and "contain" — so
the only principals it could ever contain were the ones it was told to protect, after a single `AccessDenied`.

## Desired outcome
- API Gateway stage throttled (20 rps / 40 burst; `POST /v1/queries` 2/5; `GET /v1/projects` 5/10) with JSON access logs;
  Athena workgroup `bytesScannedCutoffPerQuery` 10 GB; `/v1/usage` bounds validated (ISO, ≤ 90 days).
- Registry GET: non-admins receive `identityArnCount`, no ARNs, no `addedBy`, profile names not profile ARNs; inputs
  capped (name/costCenter ≤ 120 chars, ≤ 50 repos, ≤ 50 identity ARNs matching an IAM/STS principal shape); repo names
  with `.`/`..` segments rejected on both the registry and the DORA API.
- Every versioned bucket expires non-current versions after 1 day and aborts stale multipart uploads; every application
  Lambda writes to a 90-day log group; alarms (to the alert topic) on API 5XX ≥ 5/5 min, Aggregator/BillCollector/
  AnomalyResponse errors, Cognito `SignInThrottles` ≥ 10/5 min; CloudFront viewer logs (90 days).
- The SDLC gate runs the base branch's `sdlc_ci_gate.py`.
- Containment: `enforcement.neverContainArns` separate from `budgetActionRoleArns`; principals normalised to the role
  behind a session before comparison; act only on configured targets and only after `containmentMinEvents` (3) within
  `containmentWindowMinutes` (10); synth refuses a target that is also never-contain or not a role.
- `infra/test/security.test.ts` asserts all of it.

## Non-goals
Lakehouse stack and `lakehouse/transform.ts` (gunzip cap, `__tums_table` allow-list — taken by the peer's P2); CloudTrail →
CloudWatch Logs (Logging stack is being replaced in P2); Full-view `recentDays` (all-time is the owner's #77 decision; the
bytes cutoff bounds it); the QA login secret in the redactor (needs a role change).
