import { APIGatewayProxyEvent } from 'aws-lambda';

/** Cognito user-pool group whose members may manage DORA target repos. Created in the Auth stack. */
export const ADMIN_GROUP = 'admin';

/**
 * Groups from the Cognito authorizer claims. API Gateway (REST) flattens the `cognito:groups`
 * array claim into a string — observed shapes are "admin", "admin,viewer" and "[admin, viewer]" —
 * while a raw JWT payload keeps it as an array, so all forms are accepted.
 */
export function getGroups(event: Pick<APIGatewayProxyEvent, 'requestContext'>): string[] {
  const raw: unknown = event.requestContext?.authorizer?.claims?.['cognito:groups'];
  return parseGroupsClaim(raw);
}

export function parseGroupsClaim(raw: unknown): string[] {
  if (raw == null) return [];
  if (Array.isArray(raw)) return raw.map(String).map((s) => s.trim()).filter(Boolean);
  if (typeof raw !== 'string') return [];
  return raw
    .replace(/^\[|\]$/g, '')
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export const isAdmin = (event: Pick<APIGatewayProxyEvent, 'requestContext'>): boolean =>
  getGroups(event).includes(ADMIN_GROUP);
