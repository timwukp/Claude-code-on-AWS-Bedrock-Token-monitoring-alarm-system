import { buildProjectLatencyRows, latencyCoverage } from './latency-projects';
import { emptyLatencyStats, foldLatency } from '../ingestion/parse';
import { latencyAddClause } from '../ingestion/latency-ddb';

// Turn stats into the flat attributes a PROJDAY item would hold after the aggregator's ADDs.
const itemFor = (projectId: string, ms: { e2eMs: number; ttfbMs?: number }[], extra: Record<string, unknown> = {}) => {
  const s = emptyLatencyStats(); for (const m of ms) foldLatency(s, m);
  const item: Record<string, unknown> = { projectId, modelId: 'm', day: '2026-09-22', invocations: ms.length, ...extra };
  for (const [ph, v] of Object.entries(latencyAddClause(s).values)) {
    item[ph.replace(/^:lb(\d+)$/, 'latB$1').replace(/^:tb(\d+)$/, 'ttfbB$1').replace(':lc', 'latencyCount').replace(':ls', 'latencySumMs').replace(':tc', 'ttfbCount').replace(':ts', 'ttfbSumMs')] = v;
  }
  return item;
};
const names = new Map([['alpha', 'Alpha'], ['beta', 'Beta']]);

describe('buildProjectLatencyRows', () => {
  it('merges a project across days and models and reads estimated percentiles from the buckets', () => {
    const rows = buildProjectLatencyRows([
      itemFor('alpha', [{ e2eMs: 1100, ttfbMs: 300 }, { e2eMs: 1900, ttfbMs: 400 }]),
      itemFor('alpha', [{ e2eMs: 1200 }, { e2eMs: 1800 }], { modelId: 'other', day: '2026-09-21' }),
    ], names);
    expect(rows).toHaveLength(1);
    const [a] = rows;
    expect(a.name).toBe('Alpha');
    expect(a.e2e.samples).toBe(4); expect(a.e2e.meanMs).toBe(1500);
    expect(a.e2e.p50).toBe(1500); expect(a.e2e.estimated).toBe(true); expect(a.e2e.openEnded).toBe(false);
    expect(a.ttft.samples).toBe(2); // first-byte is a subset population, never added to e2e
    expect(a.ttft.p50).toBe(375);   // 2 samples in (250,500]: rank 1 of 2 → 250 + 250*0.5
  });
  it('sorts by p95 descending and drops projects with no latency samples', () => {
    const rows = buildProjectLatencyRows([
      itemFor('alpha', [{ e2eMs: 100 }]),
      itemFor('beta', [{ e2eMs: 30_000 }]),
      { projectId: 'gamma', modelId: 'm', day: '2026-09-22', invocations: 12 }, // pre-rollout item: tokens only
    ], names);
    expect(rows.map((r) => r.projectId)).toEqual(['beta', 'alpha']);
  });
  it('flags a percentile that lands in the open-ended top bucket as a lower bound', () => {
    const [r] = buildProjectLatencyRows([itemFor('alpha', [{ e2eMs: 70_000 }, { e2eMs: 90_000 }])], names);
    expect(r.e2e.p95).toBe(64_000); expect(r.e2e.openEnded).toBe(true);
  });
  it('falls back to the projectId when the registry has no name', () => {
    const [r] = buildProjectLatencyRows([itemFor('untagged', [{ e2eMs: 10 }])], names);
    expect(r.name).toBe('untagged');
  });
});

describe('latencyCoverage', () => {
  it('reports how many of the window\'s invocations carry a latency sample', () => {
    const c = latencyCoverage([
      itemFor('alpha', [{ e2eMs: 100 }, { e2eMs: 200 }], { invocations: 5 }),
      { projectId: 'gamma', invocations: 15 },
    ]);
    expect(c).toEqual({ invocations: 20, withLatency: 2, pct: 10 });
    expect(latencyCoverage([])).toEqual({ invocations: 0, withLatency: 0, pct: null });
  });
});

describe('items without projectId', () => {
  it('read as untagged rather than being dropped', () => {
    const bare = itemFor('x', [{ e2eMs: 500 }]); delete (bare as any).projectId;
    const rows = buildProjectLatencyRows([bare], names);
    expect(rows).toHaveLength(1); expect(rows[0].projectId).toBe('untagged'); expect(rows[0].e2e.samples).toBe(1);
  });
});
