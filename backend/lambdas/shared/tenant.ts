import { APIGatewayProxyEvent } from 'aws-lambda';

/**
 * Extracts the tenant scope from the Cognito JWT claims. Every data access MUST be filtered by
 * this value — it is the backbone of multi-tenant isolation (Well-Architected Security pillar).
 *
 * The custom attribute is configured in AuthStack as `custom:tenantId`.
 */
export function getTenantId(event: APIGatewayProxyEvent): string {
  const claims = event.requestContext?.authorizer?.claims ?? {};
  const tenantId = claims['custom:tenantId'];
  if (!tenantId) {
    throw new Error('Missing tenant claim on token — refusing cross-tenant access.');
  }
  return tenantId;
}
