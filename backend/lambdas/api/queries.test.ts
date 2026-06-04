import { sanitizeTenant } from './queries';

/**
 * Regression test for a real bug found during live validation: the tenant sanitizer stripped
 * the '/' from IAM ARNs (e.g. user/alice), so the Athena tenant filter matched nothing and the
 * forensic query returned zero rows. See docs/VERIFICATION.md.
 */
describe('sanitizeTenant', () => {
  it('preserves a full IAM ARN including the slash', () => {
    const arn = 'arn:aws:iam::123456789012:user/alice';
    expect(sanitizeTenant(arn)).toBe(arn);
  });

  it('preserves a role-session ARN', () => {
    const arn = 'arn:aws:sts::123456789012:assumed-role/Team/session-name';
    expect(sanitizeTenant(arn)).toBe(arn);
  });

  it('neutralizes a SQL-injection attempt (quotes escaped, spaces/operators stripped)', () => {
    // Quotes are doubled then non-allowed chars (incl. spaces) are removed → harmless token.
    expect(sanitizeTenant("x' OR '1'='1")).toBe('xOR11');
  });

  it('drops dangerous characters like semicolons and parentheses', () => {
    expect(sanitizeTenant('a;DROP TABLE t;--')).toBe('aDROPTABLEt--');
  });
});
