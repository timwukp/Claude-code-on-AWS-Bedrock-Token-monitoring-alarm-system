import {
  AttributionMaps, InvocationRecord, aggregate, aggregateByProject, aggregateByProjectDay,
  dayBucketOf, deriveProject,
} from './parse';

const AIP = 'arn:aws:bedrock:us-east-1::application-inference-profile/abc123opaque';
const rec = (o: Partial<InvocationRecord> = {}): InvocationRecord => ({
  timestamp: '2026-09-17T06:54:27Z',
  requestId: `req-${Math.random()}`,
  modelId: 'us.anthropic.claude-sonnet-4-6',
  identity: { arn: 'arn:aws:iam:::user/Alice' },
  input: { inputTokenCount: 100, cacheReadInputTokenCount: 10 },
  output: { outputTokenCount: 20 },
  ...o,
});
const maps = (): AttributionMaps => ({
  profiles: new Map([[AIP, { projectId: 'token-monitoring', underlyingModelId: 'us.anthropic.claude-sonnet-4-6' }]]),
  identities: new Map([['arn:aws:iam:::user/alice', 'proj-alice']]),
});

describe('deriveProject precedence', () => {
  it('AIP profile hit wins and rewrites the effective model id', () => {
    const r = rec({ modelId: AIP, requestMetadata: { project_id: 'proj-meta' } });
    expect(deriveProject(r, maps())).toEqual({ projectId: 'token-monitoring', effectiveModelId: 'us.anthropic.claude-sonnet-4-6' });
  });
  it('requestMetadata beats identity hints', () => {
    const r = rec({ requestMetadata: { project_id: 'proj-meta' } });
    expect(deriveProject(r, maps())).toEqual({ projectId: 'proj-meta', effectiveModelId: r.modelId });
  });
  it('identity hint applies case-insensitively when nothing stronger exists', () => {
    expect(deriveProject(rec(), maps())).toEqual({ projectId: 'proj-alice', effectiveModelId: 'us.anthropic.claude-sonnet-4-6' });
  });
  it('falls back to untagged, and behaves legacy without maps', () => {
    const stranger = rec({ identity: { arn: 'arn:aws:iam:::user/bob' } });
    expect(deriveProject(stranger, maps()).projectId).toBe('untagged');
    expect(deriveProject(rec({ modelId: AIP })).projectId).toBe('untagged'); // no maps → no resolution
    expect(deriveProject(rec({ requestMetadata: { project_id: 'p' } })).projectId).toBe('p');
  });
});

describe('aggregation with attribution maps', () => {
  it('aggregate() and aggregateByProject() key on the effective model id', () => {
    const rs = [rec({ modelId: AIP, requestId: 'a' }), rec({ requestId: 'b' })];
    const usage = [...aggregate(rs, maps()).values()];
    expect(usage).toHaveLength(1); // both resolve to the same underlying model + hour
    expect(usage[0].modelId).toBe('us.anthropic.claude-sonnet-4-6');
    expect(usage[0].invocations).toBe(2);

    const byProject = [...aggregateByProject(rs, maps()).values()];
    const ids = byProject.map((p) => `${p.projectId}|${p.modelId}`).sort();
    expect(ids).toEqual([
      'proj-alice|us.anthropic.claude-sonnet-4-6', // direct call attributed via identity hint
      'token-monitoring|us.anthropic.claude-sonnet-4-6',
    ]);
  });
});

describe('day bucketing', () => {
  it('dayBucketOf truncates to the UTC day', () => {
    expect(dayBucketOf('2026-06-03T06:54:27Z')).toBe('2026-06-03');
  });
  it('aggregateByProjectDay splits by day and de-dups requestIds across files', () => {
    const dup = rec({ modelId: AIP, requestId: 'same', timestamp: '2026-09-16T23:59:59Z' });
    const rs1 = [dup, rec({ modelId: AIP, requestId: 'x', timestamp: '2026-09-17T00:00:01Z' })];
    const m = aggregateByProjectDay(rs1, maps());
    // simulate the same record arriving in a second file: merge sets shouldn't double-count
    const again = aggregateByProjectDay([dup], maps());
    for (const [k, v] of again) {
      const e = m.get(k)!;
      for (const id of v.requestIds) {
        if (!e.requestIds.has(id)) throw new Error('expected duplicate to be present');
      }
    }
    const days = [...m.values()].map((v) => `${v.day}|${v.projectId}|${v.invocations}`).sort();
    expect(days).toEqual(['2026-09-16|token-monitoring|1', '2026-09-17|token-monitoring|1']);
    expect([...m.values()].every((v) => v.modelId === 'us.anthropic.claude-sonnet-4-6')).toBe(true);
  });
});

describe('detectRunaways (#14)', () => {
  const price = (modelId: string, i: number, o: number, c: number) =>
    modelId.includes('sonnet') ? i * 3e-6 + o * 15e-6 + c * 3e-7 : 0;
  it('flags only requests above the threshold, prices the AIP-resolved model, de-dups requestIds', () => {
    const big = rec({ modelId: AIP, requestId: 'big', input: { inputTokenCount: 20_000_000 } }); // $60 via resolved sonnet
    const small = rec({ requestId: 'small' }); // ~0.0006
    const hits = deriveRunaways([big, small, big]);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ requestId: 'big', projectId: 'token-monitoring', modelId: 'us.anthropic.claude-sonnet-4-6' });
    expect(hits[0].estimatedUsd).toBeCloseTo(60, 1);
  });
  it('threshold boundary is exclusive and non-positive thresholds disable the guard', () => {
    const exactly = rec({ requestId: 'x', input: { inputTokenCount: 16_666_666 }, output: { outputTokenCount: 0 } }); // ×3e-6 = $49.999998
    expect(deriveRunaways([exactly], 50)).toHaveLength(0);
    expect(deriveRunaways([exactly], 49.99)).toHaveLength(1);
    expect(deriveRunaways([exactly], 0)).toHaveLength(0);
  });
  function deriveRunaways(rs: InvocationRecord[], threshold = 50) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { detectRunaways } = require('./parse');
    return detectRunaways(rs, maps(), threshold, price);
  }
});
