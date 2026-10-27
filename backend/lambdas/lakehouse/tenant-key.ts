/**
 * The tenant key the lakehouse groups by. The ingestion path's `tenantOf` falls back to the raw
 * `identity.arn`, which for an assumed role includes the session name — every AgentCore session
 * became its own tenant (2,524 of them). Here a session collapses to its role.
 */
export type CallerType = 'user' | 'role' | 'api_key_user' | 'service' | 'unknown';

const ASSUMED_ROLE = /^arn:aws:sts::(\d{12}):assumed-role\/(.+)\/[^/]+$/;
const IAM_ROLE = /^arn:aws:iam::\d{12}:role\/.+$/;
const IAM_USER = /^arn:aws:iam::\d{12}:user\/(.+)$/;
const IAM_ROOT = /^arn:aws:iam::\d{12}:root$/;
const SERVICE_PRINCIPAL = /^[a-z0-9.-]+\.amazonaws\.com$/;

export function tenantKeyOf(identityArn: string | undefined, requestMetadataTenant?: string): { tenantKey: string; callerType: CallerType } {
  const arn = (identityArn ?? '').trim();
  const callerType = callerTypeOf(arn);
  if (requestMetadataTenant) return { tenantKey: requestMetadataTenant, callerType };
  if (!arn) return { tenantKey: 'unknown', callerType: 'unknown' };
  const m = arn.match(ASSUMED_ROLE);
  if (m) return { tenantKey: `arn:aws:iam::${m[1]}:role/${m[2]}`, callerType: 'role' };
  return { tenantKey: arn, callerType };
}

function callerTypeOf(arn: string): CallerType {
  if (!arn) return 'unknown';
  if (ASSUMED_ROLE.test(arn) || IAM_ROLE.test(arn)) return 'role';
  const u = arn.match(IAM_USER);
  if (u) return u[1].startsWith('BedrockAPIKey-') ? 'api_key_user' : 'user';
  if (IAM_ROOT.test(arn)) return 'user';
  if (SERVICE_PRINCIPAL.test(arn)) return 'service';
  return 'unknown';
}
