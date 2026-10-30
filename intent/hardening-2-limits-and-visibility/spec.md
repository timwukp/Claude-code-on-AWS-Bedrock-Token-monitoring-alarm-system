# Spec: hardening 2 — limits and visibility

- **Intent:** ./intent.md
- **Author:** Claude (AI agent)
- **Accepted-by:** Tim WU
- **Status:** shipped

## Behaviour
1. `infra/lib/stacks/api-stack.ts` — `deployOptions`: `throttlingRateLimit 20`, `throttlingBurstLimit 40`, `accessLogDestination`
   (90-day log group) with `jsonWithStandardFields`, `methodOptions` `/v1/queries/POST` 2/5 and `/v1/projects/GET` 5/10; every
   `NodejsFunction` gets `logGroup` (90 days); `Api5xxAlarm` (`metricServerError` Sum ≥ 5 / 5 min) → `props.alertTopic`.
2. `infra/lib/stacks/data-stack.ts` — workgroup `bytesScannedCutoffPerQuery: 10 GiB`; `secureBucket` always has a lifecycle rule
   with `noncurrentVersionExpiration 1 d`, `abortIncompleteMultipartUploadAfter 7 d` (+ `expiration` when given).
3. `infra/lib/stacks/etl-stack.ts`, `automation-stack.ts`, `dora-stack.ts` — `logGroup` on every function; `AggregatorErrors`,
   `BillCollectorErrors`, `AnomalyResponseErrors` alarms (Errors Sum ≥ 1 / 15 min) → alert topic.
4. `infra/lib/stacks/auth-stack.ts` — optional `alertTopic` prop; `SignInThrottlesAlarm` (AWS/Cognito, Sum ≥ 10 / 5 min).
5. `infra/lib/stacks/frontend-stack.ts` — `CfLogs` bucket (S3-managed, BUCKET_OWNER_PREFERRED, LOG_DELIVERY_WRITE, 90-day expiry)
   and `enableLogging` on the distribution.
6. `infra/lib/config/types.ts` — `enforcement.neverContainArns`, `containmentMinEvents`, `containmentWindowMinutes`.
   `infra/lib/stacks/automation-stack.ts` — env `CONTAINMENT_ALLOWLIST` = neverContainArns, `CONTAINMENT_TARGETS` =
   budgetActionRoleArns, `CONTAINMENT_MIN_EVENTS`, `CONTAINMENT_WINDOW_MIN`; synth-time guard (target ∈ never-contain, or
   target not an IAM role ARN → throw).
7. `backend/lambdas/anomaly-response/containment.ts` — `normalizePrincipal`, `DEFAULT_MIN_EVENTS`, `decideContainment`
   with `targets`, `recentEvents`, `minEvents`. `index.ts` — `countRecentDenials` (counter item `CONTAIN#<role>` in the
   anomalies table, TTL = window) and the new inputs.
8. `backend/lambdas/api/usage.ts` — `usageRange(from, to)`, `USAGE_MAX_DAYS 90`, 400 on invalid.
9. `backend/lambdas/api/project-registry.ts` — `toProjectView(p, admin)`; `list` redacts for non-admins.
   `backend/lambdas/shared/project-registry.ts` — `MAX_TEXT 120`, `MAX_LIST 50`, `IDENTITY_ARN_RE`, `hasDotSegment`;
   `validateProject` enforces them. `backend/lambdas/api/dora.ts` — `validRepo` rejects dot segments.
10. `frontend/src/api/client.ts`, `frontend/src/pages/SettingsPage.tsx` — `identityArnCount`, nullable `addedBy`.
11. `.github/workflows/sdlc-gate.yml` — the gate script is taken from `origin/<base_ref>` into `$RUNNER_TEMP` and run from there.
12. `infra/bin/infra.ts`, `infra/test/synth.ts` — pass `automation.alertTopic` to Auth and Api. `infra/test/security.test.ts`
    — 7 new invariants (throttling + access log, bytes cutoff, lifecycle, log groups, alarms, CloudFront logs, containment guard).

## Acceptance
- Unit: backend 540 (+5: usageRange ×3, containment ×2 rewritten), infra 45 invariants incl. the 7 new; synth 11 stacks;
  actionlint clean.
- Live after deploy: `GET /v1/usage?from=0&to=z` → 400; a viewer token hitting `POST /v1/queries` 10× in a second → 429s;
  `describe-stage` shows the method settings; a non-admin registry GET has no `identityArns` values; CloudWatch shows the
  five alarms in OK; the raw-log bucket's lifecycle has the non-current rule.

## Out of scope
See the intent's Non-goals.
