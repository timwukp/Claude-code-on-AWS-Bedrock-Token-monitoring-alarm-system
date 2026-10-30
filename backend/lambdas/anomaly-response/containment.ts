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
  /** ARNs that must never be contained (admins, the response Lambda's own role, etc.). Role or session form. */
  allowList: string[];
  /**
   * The role ARNs the deny policy may be attached to — the only principals IAM lets this Lambda touch
   * (feature-49). Empty = no targets configured, never act. Separate from `allowList`: before feature-49 the
   * stack handed the SAME list to both, so the only containable roles were the ones marked "never contain".
   */
  targets?: string[];
  /** AccessDenied events seen from this principal inside the window, including this one. */
  recentEvents?: number;
  /** How many events it takes to act (default 3): one AccessDenied is what "model access not enabled" looks like. */
  minEvents?: number;
}

/** `arn:aws:sts::<acct>:assumed-role/<role>/<session>` → `arn:aws:iam::<acct>:role/<role>`; anything else unchanged (lower-cased). */
export function normalizePrincipal(arn: string): string {
  const m = /^arn:(aws[a-z-]*):sts::(\d{12}):assumed-role\/([^/]+)\/[^/]+$/i.exec(arn.trim());
  return (m ? `arn:${m[1]}:iam::${m[2]}:role/${m[3]}` : arn.trim()).toLowerCase();
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

export const DEFAULT_MIN_EVENTS = 3;

export function decideContainment(input: ContainmentInput): ContainmentDecision {
  if (!input.enabled) return { act: false, reason: 'auto-containment disabled (notify-only)' };
  const principal = normalizePrincipal(input.principalArn);
  // CloudTrail delivers assumed-role SESSION ARNs; operators list ROLE ARNs. Compare the role behind both.
  if (input.allowList.some((a) => normalizePrincipal(a) === principal)) {
    return { act: false, reason: 'principal is allow-listed (never contain)' };
  }
  const target = parsePrincipal(input.principalArn);
  if (!target) return { act: false, reason: `unparseable principal ARN: ${input.principalArn}` };
  const targets = (input.targets ?? []).map(normalizePrincipal);
  if (targets.length === 0) return { act: false, reason: 'no containment targets configured' };
  if (!targets.includes(principal)) return { act: false, reason: 'principal is not a configured containment target (IAM would refuse)' };
  const min = input.minEvents ?? DEFAULT_MIN_EVENTS;
  const seen = input.recentEvents ?? 1;
  if (seen < min) return { act: false, reason: `${seen}/${min} AccessDenied events in the window — not yet` };
  return { act: true, reason: `contain ${target.type} ${target.name} after ${seen} events`, target };
}
