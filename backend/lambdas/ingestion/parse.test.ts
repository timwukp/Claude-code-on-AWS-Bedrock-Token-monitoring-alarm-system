import { parseLogFile, aggregate, tenantOf, hourBucketOf, aggregateByProject, projectOf } from './parse';

/**
 * Fixtures mirror the REAL delivered log schema verified in docs/VERIFICATION.md
 * (identity.arn present, cache token counts, newline-delimited). No PII — synthetic ARNs/text.
 */
const NDJSON = [
  JSON.stringify({
    schemaType: 'ModelInvocationLog', timestamp: '2026-06-03T06:54:27Z',
    accountId: '111122223333', region: 'us-east-1', requestId: 'req-1',
    operation: 'InvokeModelWithResponseStream',
    modelId: 'arn:aws:bedrock:us-east-1:111122223333:inference-profile/us.anthropic.claude-opus-4-8',
    identity: { arn: 'arn:aws:iam::111122223333:user/demo' },
    input: { inputTokenCount: 10, cacheReadInputTokenCount: 1000, cacheWriteInputTokenCount: 5 },
    output: { outputTokenCount: 200 },
  }),
  JSON.stringify({
    schemaType: 'ModelInvocationLog', timestamp: '2026-06-03T06:59:00Z',
    requestId: 'req-2', modelId: 'arn:...claude-opus-4-8',
    identity: { arn: 'arn:aws:iam::111122223333:user/demo' },
    input: { inputTokenCount: 5 }, output: { outputTokenCount: 50 },
  }),
  '', // blank line — must be skipped
  '{ this is not json', // malformed — must be skipped, not throw
].join('\n');

describe('parseLogFile', () => {
  it('parses newline-delimited JSON and skips blank/malformed lines', () => {
    const recs = parseLogFile(NDJSON);
    expect(recs).toHaveLength(2);
    expect(recs[0].requestId).toBe('req-1');
  });
});

describe('tenantOf', () => {
  it('prefers requestMetadata.tenant', () => {
    expect(tenantOf({ requestId: 'x', timestamp: 't', modelId: 'm', requestMetadata: { tenant: 'acme' }, identity: { arn: 'arn:...' } } as any)).toBe('acme');
  });
  it('falls back to identity.arn', () => {
    expect(tenantOf({ requestId: 'x', timestamp: 't', modelId: 'm', identity: { arn: 'arn:aws:iam::1:user/u' } } as any)).toBe('arn:aws:iam::1:user/u');
  });
  it('falls back to "unknown"', () => {
    expect(tenantOf({ requestId: 'x', timestamp: 't', modelId: 'm' } as any)).toBe('unknown');
  });
});

describe('hourBucketOf', () => {
  it('truncates an ISO timestamp to the hour', () => {
    expect(hourBucketOf('2026-06-03T06:54:27Z')).toBe('2026-06-03T06:00:00Z');
  });
});

describe('aggregate', () => {
  it('folds per (tenant, model, hour) and sums token counts', () => {
    const map = aggregate(parseLogFile(NDJSON));
    // Same tenant + same hour but different model strings → 2 buckets.
    const values = [...map.values()];
    const demoOpus = values.find((v) => v.modelId.includes('opus-4-8') && v.invocations === 1);
    expect(demoOpus?.inputTokens).toBe(10);
    expect(demoOpus?.cacheReadTokens).toBe(1000);
    expect(demoOpus?.outputTokens).toBe(200);
  });

  it('is idempotent — duplicate requestIds are not double-counted', () => {
    const recs = parseLogFile(NDJSON);
    const doubled = [...recs, ...recs];
    const single = aggregate(recs);
    const twice = aggregate(doubled);
    const sum = (m: Map<string, any>) => [...m.values()].reduce((s, v) => s + v.invocations, 0);
    expect(sum(twice)).toBe(sum(single));
  });
});

describe('projectOf', () => {
  it('returns the project_id metadata tag', () => {
    expect(projectOf({ requestId: 'x', timestamp: 't', modelId: 'm', requestMetadata: { project_id: 'proj-bravo' } } as any)).toBe('proj-bravo');
  });
  it('falls back to "untagged" when no project tag', () => {
    expect(projectOf({ requestId: 'x', timestamp: 't', modelId: 'm' } as any)).toBe('untagged');
  });
});

describe('aggregateByProject', () => {
  const recs = (n: number, proj: string, user: string, reqId: string) => ({
    requestId: reqId, timestamp: '2026-06-05T06:00:00Z', modelId: 'm1',
    identity: { arn: 'arn:aws:iam::1:user/a' },
    requestMetadata: { tenant: 't1', project_id: proj, user_id: user },
    input: { inputTokenCount: n, cacheReadInputTokenCount: n * 10 }, output: { outputTokenCount: n * 2 },
  });

  it('groups by tenant+project+model and counts distinct users', () => {
    const m = aggregateByProject([recs(10, 'proj-a', 'u1', 'r1'), recs(5, 'proj-a', 'u2', 'r2')] as any);
    const a = [...m.values()].find((x) => x.projectId === 'proj-a')!;
    expect(a.inputTokens).toBe(15);
    expect(a.outputTokens).toBe(30);
    expect(a.cacheReadTokens).toBe(150);
    expect(a.invocations).toBe(2);
    expect(a.users.size).toBe(2); // u1, u2
  });

  it('is idempotent — duplicate requestIds are not double-counted', () => {
    const one = aggregateByProject([recs(10, 'proj-a', 'u1', 'r1')] as any);
    const dup = aggregateByProject([recs(10, 'proj-a', 'u1', 'r1'), recs(10, 'proj-a', 'u1', 'r1')] as any);
    const inv = (m: Map<string, any>) => [...m.values()].reduce((s, v) => s + v.invocations, 0);
    expect(inv(dup)).toBe(inv(one));
  });

  it('rolls untagged records under "untagged"', () => {
    const m = aggregateByProject([{ requestId: 'r9', timestamp: '2026-06-05T06:00:00Z', modelId: 'm1' }] as any);
    expect([...m.values()][0].projectId).toBe('untagged');
  });
});
