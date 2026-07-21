import { parsePrincipal, decideContainment } from './containment';

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

  it('returns strictly increasing timestamps across sequential decisions', () => {
    const d1 = decideContainment({ enabled: true, principalArn: arn, allowList: [] });
    const d2 = decideContainment({ enabled: true, principalArn: arn, allowList: [] });
    expect(d2.timestamp).toBeGreaterThan(d1.timestamp);
  });

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

  it('acts on a parseable, non-allow-listed principal when enabled', () => {
    const d = decideContainment({ enabled: true, principalArn: arn, allowList: [] });
    expect(d.act).toBe(true);
    expect(d.target).toEqual({ type: 'role', name: 'Suspicious' });
  });
});
