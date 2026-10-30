# Feature 49 — Hardening 2: limits, visibility, and a hard-stop that targets the right role

- **Chain:** `intent/hardening-2-limits-and-visibility/` · **Branch:** `feat/hardening-2-limits-and-visibility` · **PR:** #113
- **Origin:** chain 2 of the 2026-10-28 security audit's hardening programme (owner-approved plan); items #6, #8, #9, #15, #16 and
  the audit's "limits" tail.
- **Date:** 2026-10-30
- **Verdict:** PASS on gates; live confirmation after the owner's deploys (table below, to fill).

## What this report has to say plainly
- **The hard-stop could only ever contain the roles it was told to protect.** `CONTAINMENT_ALLOWLIST` and the roles the Lambda
  may attach the deny policy to were the same config list, and the allow-list compared CloudTrail *session* ARNs against *role*
  ARNs — a miss by construction. One `AccessDeniedException` (what "model access not enabled" looks like) would have attached
  the deny policy immediately. Enforcement is off in dev, so nothing happened; it would have on the first environment that
  turned it on. Now: a separate `neverContainArns`, role-normalised comparison, action only on configured targets and only after
  3 events in 10 minutes, and synth refuses a misconfiguration.
- **No ceilings existed.** Any viewer could start unlimited all-time Athena scans through `GET /v1/projects` or `POST /v1/queries`
  with no API throttling and no bytes cutoff. Now 20 rps stage-wide, 2 rps on the query route, 10 GB per Athena query.
- **No one would have been told.** No alarm on Lambda errors, API 5XX or sign-in throttling; Lambda logs lived forever; the
  raw-log bucket's 365-day retention applied to current versions only. Now five alarms to the alert topic, 90-day log groups,
  non-current versions gone after a day, CloudFront viewer logs.
- **The registry leaked administration detail to every tenant** — identity ARNs (account id), admin e-mails, profile ARNs.
  Now admin-only; non-admins get counts and names.

## Scope
| Area | Change |
|---|---|
| `api-stack.ts` | stage throttling + per-method limits, JSON access logs, 90-day log groups on all 12 functions, `Api5xxAlarm` |
| `data-stack.ts` | Athena `bytesScannedCutoffPerQuery` 10 GB; lifecycle (non-current 1 d, multipart 7 d) on every bucket |
| `etl-stack.ts`, `automation-stack.ts`, `dora-stack.ts`, `auth-stack.ts` | log groups; `AggregatorErrors`, `BillCollectorErrors`, `AnomalyResponseErrors`, `SignInThrottlesAlarm` |
| `frontend-stack.ts` | `CfLogs` bucket + distribution logging |
| `types.ts`, `automation-stack.ts`, `anomaly-response/containment.ts` (+test), `index.ts` | `neverContainArns`, targets, `normalizePrincipal`, event threshold, windowed counter, synth guard |
| `api/usage.ts` (+test) | `usageRange` (ISO, ≤ 90 d, 400 otherwise) |
| `api/project-registry.ts`, `shared/project-registry.ts` (+test), `api/dora.ts`, `client.ts`, `SettingsPage.tsx` | non-admin redaction, input caps, ARN shape, dot-segment rejection |
| `.github/workflows/sdlc-gate.yml` | gate script from the base branch |
| `infra/test/security.test.ts`, `synth.ts`, `bin/infra.ts` | 7 new invariants; alert topic plumbed to Auth and Api |

## Gates
| Gate | Result |
|---|---|
| Backend `jest` / `tsc --noEmit` | PASS — 540/540 (+5) |
| Frontend `tsc --noEmit` / `vite build` | PASS |
| Infra `jest` (incl. `security.test.ts`) / `cdk synth -c env=ci` | PASS — 45/45 (+7) · 11 stacks |
| `actionlint` | clean |
| `sdlc_ci_gate.py --require-active` | PASS |
| Leak scan | clean |

## Live — after the owner's deploys (to fill)
| Check | Result |
|---|---|
| `GET /v1/usage?from=0&to=z` | TBD — 400 |
| `aws apigateway get-stage` method settings | TBD — `*/*` 20/40, `/v1/queries POST` 2/5 |
| Athena `get-work-group` | TBD — `BytesScannedCutoffPerQuery` 10737418240 |
| Non-admin registry GET | TBD — `identityArns: []`, `identityArnCount`, `addedBy: null` |
| CloudWatch alarms | TBD — 5 new alarms in OK |
| Raw-log bucket lifecycle | TBD — non-current 1 d rule present |
| Old `/aws/lambda/<fn>` log groups | TBD — to delete by hand after the switch (they never expire) |

## Known limits, stated rather than fixed
- Lakehouse hardening (gunzip cap, `__tums_table` allow-list) and CloudTrail → CW Logs ride with the peer's P2.
- The Full view remains all-time by the owner's #77 decision; the 10 GB cutoff bounds it.
- The QA login secret's literal values are still not in the redactor (needs a Secrets Manager read in the workflow role).
