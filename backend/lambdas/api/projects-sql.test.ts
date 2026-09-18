/**
 * Full-view (Athena) SQL builder — the fix for qa finding F-1101.
 *
 * The Full view attributed from requestMetadata alone, so profile-routed traffic (whose modelId
 * IS the AIP ARN, and which carries no project_id) could only land in 'untagged'. These tests
 * pin the precedence, the no-profile fallback, and the injection guard on inlined values.
 */
process.env.ATHENA_WORKGROUP = 'wg';
process.env.GLUE_DATABASE = 'db';

import { buildFullSql, MAX_PROFILE_ROWS } from './projects';

const ARN = 'arn:aws:bedrock:us-east-1:111111111111:application-inference-profile/abc123';
const TENANT = 'arn:aws:iam::111111111111:user/demo';

describe('buildFullSql', () => {
  it('inlines resolved profiles as a CTE and joins them on modelId', () => {
    const sql = buildFullSql(TENANT, [{ arn: ARN, projectId: 'proj-alpha' }]);
    expect(sql).toContain('WITH profile_map (profile_arn, project_id) AS (VALUES');
    expect(sql).toContain(`('${ARN}', 'proj-alpha')`);
    expect(sql).toContain('LEFT JOIN profile_map ap\n        ON l.modelId = ap.profile_arn');
  });

  it('puts the AIP tier ahead of the metadata tier, matching the aggregator precedence', () => {
    const sql = buildFullSql(TENANT, [{ arn: ARN, projectId: 'proj-alpha' }]);
    const project = sql.slice(sql.indexOf('COALESCE'), sql.indexOf('AS project'));
    // pm/ap (AIP tier) must be evaluated before m/requestMetadata (metadata tier).
    expect(project.indexOf('pm.project_name')).toBeLessThan(project.indexOf('m.project_name'));
    expect(project.indexOf('ap.project_id')).toBeLessThan(project.indexOf("requestMetadata['project_id']"));
    expect(project.trimEnd().endsWith("'untagged')")).toBe(true);
  });

  it('resolves name and cost centre for an AIP row through the same project_mapping CSV', () => {
    const sql = buildFullSql(TENANT, [{ arn: ARN, projectId: 'proj-alpha' }]);
    expect(sql).toContain('LEFT JOIN project_mapping pm\n        ON ap.project_id = pm.project_id');
    expect(sql).toContain("COALESCE(pm.cost_center, m.cost_center, '—')");
  });

  it('falls back to the pre-fix shape when no profile resolves — an empty VALUES is a syntax error', () => {
    const sql = buildFullSql(TENANT, []);
    expect(sql).not.toContain('WITH');
    expect(sql).not.toContain('profile_map');
    expect(sql).toContain("COALESCE(m.project_name, l.requestMetadata['project_id'], 'untagged')");
    // Still a single-pass grouped query.
    expect(sql).toContain('GROUP BY 1, 2');
  });

  it('groups once in SQL so COUNT(DISTINCT user) is never re-aggregated', () => {
    // Folding profile rows into projects in the Lambda would over-count users shared by two
    // groups; the fold therefore has to happen before the aggregate, i.e. in the GROUP BY key.
    for (const profiles of [[], [{ arn: ARN, projectId: 'proj-alpha' }]]) {
      const sql = buildFullSql(TENANT, profiles);
      expect(sql.match(/GROUP BY/g)).toHaveLength(1);
      expect(sql).toContain("COUNT(DISTINCT l.requestMetadata['user_id'])");
    }
  });

  it('sanitizes inlined values and the tenant id', () => {
    const sql = buildFullSql("x' OR '1'='1", [
      { arn: "arn:aws:bedrock:'; DROP TABLE logs; --", projectId: "p'--" },
    ]);
    expect(sql).not.toMatch(/DROP TABLE/);
    // No odd number of quotes anywhere: every quote is either a delimiter or doubled.
    expect(sql.split("'").length % 2).toBe(1);
  });

  it('caps inlined rows so a pathological cache cannot approach the Athena query limit', () => {
    const many = Array.from({ length: MAX_PROFILE_ROWS + 25 }, (_, i) => ({
      arn: `${ARN}-${i}`, projectId: `proj-${i}`,
    }));
    const sql = buildFullSql(TENANT, many);
    expect(sql).toContain(`proj-${MAX_PROFILE_ROWS - 1}'`);
    expect(sql).not.toContain(`proj-${MAX_PROFILE_ROWS}'`);
    expect(sql.length).toBeLessThan(262_144);
  });
});
