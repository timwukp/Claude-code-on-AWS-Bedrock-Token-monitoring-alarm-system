import { projectExprFrom, sanitizeTenant, TEMPLATES } from './queries';

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

/**
 * qa F-1101: the by-project Athena view attributed from requestMetadata alone, so profile-routed
 * calls (modelId = the AIP ARN, no project_id) could only land in 'untagged' — it reported ~99.97%
 * untagged where the DynamoDB path attributed 20 projects. These pin the added AIP tier.
 */
describe('projectExprFrom / byProject attribution tiers', () => {
  const ARN = 'arn:aws:bedrock:us-east-1:111111111111:application-inference-profile/abc';
  const ctxOf = (projectExpr: string | null) => ({ modelExpr: 'l.modelId', projectExpr });

  it('emits a CASE with no ELSE so a non-profile call falls through to the next tier', () => {
    const expr = projectExprFrom([{ arn: ARN, projectId: 'proj-alpha' }]);
    expect(expr).toBe(`CASE WHEN l.modelId = '${ARN}' THEN 'proj-alpha' END`);
    expect(expr).not.toContain('ELSE');
  });

  it('skips profiles with no project tag and unsafe values', () => {
    expect(projectExprFrom([{ arn: ARN, projectId: 'untagged' }])).toBeNull();
    expect(projectExprFrom([{ arn: ARN }])).toBeNull();
    expect(projectExprFrom([{ arn: "arn'; DROP TABLE t; --", projectId: 'p' }])).toBeNull();
    expect(projectExprFrom([{ arn: ARN, projectId: "p' OR '1'='1" }])).toBeNull();
  });

  it('puts the AIP tier ahead of requestMetadata, and untagged last', () => {
    const sql = TEMPLATES.byProject('arn:aws:iam::111111111111:user/demo', 90,
      ctxOf(projectExprFrom([{ arn: ARN, projectId: 'proj-alpha' }])));
    const project = sql.slice(sql.indexOf('COALESCE'), sql.indexOf('AS project'));
    expect(project.indexOf('CASE WHEN l.modelId')).toBeLessThan(project.indexOf('m.project_name'));
    expect(project.indexOf('m.project_name')).toBeLessThan(project.indexOf("requestMetadata['project_id']"));
    expect(project).toContain("'untagged'");
  });

  it('omits the tier entirely when nothing resolves — identical to the pre-fix SQL', () => {
    const sql = TEMPLATES.byProject('arn:aws:iam::111111111111:user/demo', 90, ctxOf(null));
    expect(sql).not.toContain('CASE WHEN l.modelId =');
    expect(sql).toContain("COALESCE(m.project_name, l.requestMetadata['project_id'], 'untagged') AS project");
  });
});
