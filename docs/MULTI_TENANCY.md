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

## Deployment assumption and trust boundary (owner decision 2026-10-28)

**One deployment = one organisation.** Tenants are internal teams of the AWS account that owns the deployment,
not separate customers. Three consequences are deliberate and should be understood before reading the isolation
table above as a security boundary between adversaries:

1. **Account-level data is shared on purpose.** The project/repo registry, the Cost Explorer bill panel, the AWS
   Budget, quota headroom and fleet latency are account-wide and visible to every tenant; the UI labels them so.
   Identity ARNs and account ids in the registry are shown to administrators only.
2. **Attribution is cooperative.** `requestMetadata.tenant` / `project_id` / `user_id` are written by whoever calls
   Bedrock in the account; the pipeline cannot verify them. A caller can mislabel its own traffic — including as
   another tenant's. The platform makes labels visible and auditable (the bill panel, unpriced/unattributed
   states); it does not make them trustworthy. A caller that must not be able to do this needs an application
   inference profile (routed, IAM-enforceable attribution) rather than metadata.
3. **Isolation does hold at the read boundary.** Every API handler scopes DynamoDB reads by the JWT's immutable
   `custom:tenantId`; Athena executions are bound to the tenant that started them; registry mutations require the
   `admin` group. Those are enforced server-side regardless of (1) and (2).

## Data ingestion requirement

For per-tenant analytics to work, the application calling Bedrock **must** set request metadata,
e.g. `requestMetadata = { "tenant": "<tenantId>", "team": "<team>" }`. Without it, usage can
only be grouped by model, not by tenant.

## Open items (TODO)

- Per-tenant rate limits / usage plans on API Gateway.
- Optional tenant-scoped IAM via session tags for defense-in-depth on Athena/S3.
- Tenant lifecycle (onboard/offboard) automation in `tums-tenants` table. (The table now also
  hosts the project registry — `REGISTRY#*` key spaces for project↔repo↔cost-center mapping,
  AIP resolutions and identity hints; see `docs/ATTRIBUTION.md`.)
