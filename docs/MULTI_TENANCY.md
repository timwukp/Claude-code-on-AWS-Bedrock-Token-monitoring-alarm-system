# Multi-Tenancy Model

The platform is built for **any customer** and many tenants per deployment. Isolation is
enforced at every layer; this doc is the contract.

## Tenant identity

- Each operator's Cognito user carries an immutable custom attribute **`custom:tenantId`**.
- API Gateway's Cognito authorizer puts the claim on the request; `backend/lambdas/shared/tenant.ts`
  reads it. A request with no tenant claim is **rejected** — there is no implicit/global scope.

## Isolation at each layer

| Layer | Mechanism |
|---|---|
| API | Every handler derives `tenantId` from the JWT and filters by it; clients can't pass it. |
| DynamoDB | Partition keys are prefixed `TENANT#<id>#…` so a query can only read one tenant's items. |
| Athena | Forensic queries are server-side templates filtered on `requestMetadata['tenant']`; raw SQL from clients is never executed. |
| S3 (curated) | Optional per-tenant prefixes; workgroup output is KMS-encrypted. |
| Attribution | Bedrock logs carry no IAM identity, so tenant attribution depends on callers tagging requests with `requestMetadata.tenant`. Document this requirement to integrators. |

## Data ingestion requirement

For per-tenant analytics to work, the application calling Bedrock **must** set request metadata,
e.g. `requestMetadata = { "tenant": "<tenantId>", "team": "<team>" }`. Without it, usage can
only be grouped by model, not by tenant.

## Open items (TODO)

- Per-tenant rate limits / usage plans on API Gateway.
- Optional tenant-scoped IAM via session tags for defense-in-depth on Athena/S3.
- Tenant lifecycle (onboard/offboard) automation in `tums-tenants` table.
