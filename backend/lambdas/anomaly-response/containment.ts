/**
 * Pure decision logic for scoped auto-containment (#5). No AWS calls, so it is unit-testable.
 *
 * Containment attaches a deny policy to the offending IAM principal. It is deliberately
 * conservative: it only acts when explicitly enabled, only on an IAM role/user ARN it can parse,
 * and never on an allow-listed principal (e.g. the operator/admin) to avoid self-lockout.
 */

export interface ContainmentInput {
  enabled: boolean;
  /** The principal ARN from the CloudTrail event (userIdentity.arn). */
  principalArn: string;
  /** ARNs that must never be contained (admins, the response Lambda's own role, etc.). */
  allowList: string[];
}

export interface ContainmentDecision {
  act: boolean;
  reason: string;
  /** Parsed { type: 'role'|'user', name } when act is true. */
  target?: { type: 'role' | 'user'; name: string };
}

/**
 * Parse an IAM ARN into a role/user target. Supports:
 *   arn:aws:iam::<acct>:role/<name>
 *   arn:aws:iam::<acct>:user/<name>
 *   arn:aws:sts::<acct>:assumed-role/<roleName>/<session>  → role <roleName>
 */
export function parsePrincipal(arn: string): { type: 'role' | 'user'; name: string } | null {
  const assumed = arn.match(/^arn:aws:sts::\d+:assumed-role\/([^/]+)\//);
  if (assumed) return { type: 'role', name: assumed[1] };
  const role = arn.match(/^arn:aws:iam::\d+:role\/(.+)$/);
  if (role) return { type: 'role', name: role[1] };
  const user = arn.match(/^arn:aws:iam::\d+:user\/(.+)$/);
  if (user) return { type: 'user', name: user[1] };
  return null;
}

export function decideContainment(input: ContainmentInput): ContainmentDecision {
  if (!input.enabled) return { act: false, reason: 'auto-containment disabled (notify-only)' };
  if (input.allowList.includes(input.principalArn)) {
    return { act: false, reason: 'principal is allow-listed (never contain)' };
  }
  const target = parsePrincipal(input.principalArn);
  if (!target) return { act: false, reason: `unparseable principal ARN: ${input.principalArn}` };
  return { act: true, reason: `contain ${target.type} ${target.name}`, target };
}
