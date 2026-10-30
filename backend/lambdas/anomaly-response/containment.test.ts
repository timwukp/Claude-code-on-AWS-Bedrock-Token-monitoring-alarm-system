import { parsePrincipal, decideContainment, normalizePrincipal } from './containment';

describe('parsePrincipal', () => {
  it('parses an IAM role ARN', () => {
    expect(parsePrincipal('arn:aws:iam::123456789012:role/MyRole')).toEqual({ type: 'role', name: 'MyRole' });
  });
  it('parses an IAM user ARN', () => {
    expect(parsePrincipal('arn:aws:iam::123456789012:user/alice')).toEqual({ type: 'user', name: 'alice' });
  });
  it('parses an assumed-role (STS) ARN to its role name', () => {
    expect(parsePrincipal('arn:aws:sts::123456789012:assumed-role/AppRole/session-1'))
      .toEqual({ type: 'role', name: 'AppRole' });
  });
  it('returns null for an unparseable ARN', () => {
    expect(parsePrincipal('not-an-arn')).toBeNull();
  });
});

describe('decideContainment', () => {
  const arn = 'arn:aws:iam::123456789012:role/Suspicious';

  it('does not act when disabled (notify-only default)', () => {
    expect(decideContainment({ enabled: false, principalArn: arn, allowList: [] }).act).toBe(false);
  });

  it('never contains an allow-listed principal (no self-lockout)', () => {
    const d = decideContainment({ enabled: true, principalArn: arn, allowList: [arn] });
    expect(d.act).toBe(false);
    expect(d.reason).toMatch(/allow-listed/);
  });

  it('does not act on an unparseable principal', () => {
    const d = decideContainment({ enabled: true, principalArn: 'weird', allowList: [] });
    expect(d.act).toBe(false);
  });

  it('acts only on a configured target, after the event threshold (feature-49)', () => {
    const target = 'arn:aws:iam::123456789012:role/Suspicious';
    // no targets configured → never acts (IAM would refuse anyway)
    expect(decideContainment({ enabled: true, principalArn: arn, allowList: [] }).act).toBe(false);
    // a target, but only the first event → wait
    expect(decideContainment({ enabled: true, principalArn: arn, allowList: [], targets: [target], recentEvents: 1 }).act).toBe(false);
    expect(decideContainment({ enabled: true, principalArn: arn, allowList: [], targets: [target], recentEvents: 2 }).reason).toMatch(/2\/3/);
    // third event → act
    const d = decideContainment({ enabled: true, principalArn: arn, allowList: [], targets: [target], recentEvents: 3 });
    expect(d.act).toBe(true);
    expect(d.target).toEqual({ type: 'role', name: 'Suspicious' });
    // a session ARN of a role that is NOT a target → not acted on
    expect(decideContainment({ enabled: true, principalArn: 'arn:aws:sts::123456789012:assumed-role/Other/s', allowList: [], targets: [target], recentEvents: 9 }).reason).toMatch(/not a configured containment target/);
  });

  it('the allow-list matches the ROLE behind a session ARN (CloudTrail delivers sessions, operators list roles)', () => {
    const session = 'arn:aws:sts::111122223333:assumed-role/Admin/tim-laptop';
    const role = 'arn:aws:iam::111122223333:role/Admin';
    expect(normalizePrincipal(session)).toBe(role.toLowerCase());
    expect(decideContainment({ enabled: true, principalArn: session, allowList: [role], targets: [role], recentEvents: 9 }).reason).toMatch(/allow-listed/);
    expect(decideContainment({ enabled: true, principalArn: role, allowList: [session], targets: [role], recentEvents: 9 }).reason).toMatch(/allow-listed/);
    // Before feature-49 this exact comparison failed, so "never contain" roles were the only ones ever contained.
  });
});
