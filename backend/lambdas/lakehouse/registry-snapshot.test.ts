import { buildRegistryRows, registryStatements } from './registry-snapshot';

const NOW = '2026-10-30T01:00:00.000Z';

describe('buildRegistryRows', () => {
  const projects = [
    { projectId: 'token-monitoring', name: 'Token Usage Monitoring', costCenter: 'CC-ENG-DEMO', repos: ['timwukp/Claude-code-on-AWS-Bedrock-Token-monitoring-alarm-system'], identityArns: [] },
    { projectId: 'llmops-agentic-system', name: 'Llmops Agentic System', costCenter: 'CC-HIST', repos: ['timwukp/llmops-agentic-system'], identityArns: ['arn:aws:iam::123456789012:role/llmops-harness-execution'] },
  ];
  const profiles = [
    { arn: 'arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/p1', projectId: 'token-monitoring' },
    { arn: 'arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/p2', projectId: 'token-monitoring' },
    { arn: 'arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/neg', projectId: 'untagged' },
  ];
  const identities = [{ identityArn: 'arn:aws:iam::123456789012:role/llmops-harness-execution', projectId: 'llmops-agentic-system' }];
  const rows = buildRegistryRows(projects, profiles, identities, NOW);

  it('folds the three partitions into one current row per project, arrays as sorted JSON, lower-cased', () => {
    expect(rows.map((r) => r.project_id)).toEqual(['llmops-agentic-system', 'token-monitoring']);
    const tm = rows[1];
    expect(tm).toMatchObject({ name: 'Token Usage Monitoring', cost_center: 'CC-ENG-DEMO', is_current: true, snapshot_ts: NOW });
    expect(JSON.parse(tm.profile_arns!)).toHaveLength(2); // the negative-cache entry is not a project's profile
    expect(JSON.parse(tm.repos!)).toEqual(['timwukp/claude-code-on-aws-bedrock-token-monitoring-alarm-system']);
    const ll = rows[0];
    expect(JSON.parse(ll.identity_arns!)).toEqual(['arn:aws:iam::123456789012:role/llmops-harness-execution']); // from the project item AND the hint, deduped
    expect(JSON.parse(ll.profile_arns!)).toEqual([]);
  });

  it('retires the previous snapshot before inserting the new one', () => {
    const stmts = registryStatements('tums-lakehouse-dev', rows);
    expect(stmts[0]).toBe('UPDATE "s3tablescatalog/tums-lakehouse-dev"."silver"."project_registry" SET is_current = false WHERE is_current = true');
    expect(stmts[1]).toContain("'llmops-agentic-system'");
    expect(stmts[1]).toContain('true)');
  });
});
