# Security Policy

## Reporting a vulnerability

Please report security issues privately to the maintainers rather than opening a public issue.
Include a description, reproduction steps, and impact. We aim to acknowledge reports promptly.

## Security model of this project

This system processes Amazon Bedrock invocation logs, which can contain **full prompt and
completion text**. Treat all deployments as handling sensitive data.

### Built-in controls

- **No public S3 buckets.** The dashboard is served only via CloudFront with Origin Access
  Control; data buckets block all public access and enforce TLS.
- **Encryption** — KMS customer-managed keys for S3, DynamoDB, and Athena results; TLS in transit.
- **Authentication** — Amazon Cognito; the API uses a Cognito JWT authorizer. No unauthenticated
  data paths.
- **Least privilege** — each Lambda is granted only the resources it needs; tenant scoping is
  enforced from the JWT claim on every request.
- **Auditability** — CloudTrail + Bedrock Model Invocation Logging.
- **Automated response is opt-in** — containment actions are disabled by default (notify-only).

### Trust boundaries (security audit 2026-10-28, feature-47)

- **The log pipeline is an input surface.** Anything a Bedrock caller in the account writes into a request
  (`requestMetadata`, body) reaches the aggregator. Counters are sanitised (`safeCount`), per-object processing is
  idempotent (`SYSTEM#PROCESSED` markers), unbounded sets are capped (`userSet` 500), and the tenant index is one
  item per tenant — so a hostile or merely huge input cannot corrupt rollups or wedge the pipeline.
- **CI runs no pull-request code with credentials.** `ui-qa-agent.yml` builds the PR with no permissions, then
  deploys and runs the agents from the base branch's tooling. The QA verdict is derived from findings, never from
  the agent's own `overall`; the bug-fix agent's diff is confined to the one file it was asked about and may not
  touch `.github/`, `infra/`, `.sdlc/`, `ci-agent/`, `intent/`, `spec/`, `scripts/`. Actions are pinned by SHA.
- **Repository and account settings this code relies on (owner-maintained):** `main` ruleset requiring a pull
  request and the `backend`/`frontend`/`infra`/`sdlc-gate` checks with no bypass; the GitHub Actions role's OIDC
  trust limited to this repository's pull requests and `main`; account-level S3 Public Access Block on.
- **Browser:** CloudFront sends HSTS, `X-Content-Type-Options`, `X-Frame-Options: DENY`, a referrer policy and a
  Content-Security-Policy (report-only until `frontend.cspEnforce` is set); Cognito tokens live in `sessionStorage`
  with a 1-hour id token and a 1-day refresh token; CORS origins must be configured outside `dev`.

- **Ceilings and alarms (feature-49):** API stage throttling with access logs; Athena 10 GB per-query cutoff; alarms on API
  5XX, pipeline Lambda errors and Cognito sign-in throttling to the alert topic; 90-day Lambda log retention; CloudFront
  viewer logs; non-current S3 versions expire after a day. Auto-containment (off by default) acts only on
  `enforcement.budgetActionRoleArns`, never on `enforcement.neverContainArns`, and only after repeated `AccessDenied`.

### Operator responsibilities

- **Model Invocation Logging captures request/response bodies.** If you only need token/metadata
  accounting, set `textDataDeliveryEnabled: false`. Otherwise apply strict retention, KMS, and
  access controls to the raw log bucket.
- **Don't put PII in `requestMetadata`** — use opaque codes (e.g. `u-2001`), not emails/names.
  Tags persist in logs that may be retained for years.
- **Rotate credentials** and review the demo/seed users before any non-demo use.
- **Review IAM** before enabling auto-containment.

### Secrets & configuration

- Environment config (`infra/lib/config/<env>.json`) and `cdk.context.json` are gitignored and
  must never be committed. Only `example.env.json` (placeholders) is tracked.
- Use AWS Secrets Manager / SSM Parameter Store for any runtime secrets — never hard-code them.

## Supported versions

This is reference/sample software provided under the MIT license; security fixes are applied to
`main` on a best-effort basis.
