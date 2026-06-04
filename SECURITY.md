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
