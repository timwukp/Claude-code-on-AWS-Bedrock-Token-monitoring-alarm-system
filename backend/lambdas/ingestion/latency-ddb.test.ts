import { emptyLatencyStats, foldLatency, LATENCY_BUCKET_COUNT, mergeLatency } from './parse';
import { latencyAddClause, latencyFromItem, latencyOnlyAdd, latencyOnlyAddWithKeys } from './latency-ddb';

describe('latencyAddClause', () => {
  it('writes nothing for a batch with no samples', () => {
    expect(latencyAddClause(emptyLatencyStats())).toEqual({ clause: '', values: {} });
  });
  it('writes count, sum and only the touched buckets; first-byte only when present', () => {
    const s = emptyLatencyStats(); foldLatency(s, { e2eMs: 1200 }); foldLatency(s, { e2eMs: 1900 });
    const c = latencyAddClause(s);
    expect(c.clause).toBe(', latencyCount :lc, latencySumMs :ls, latB3 :lb3');
    expect(c.values).toEqual({ ':lc': 2, ':ls': 3100, ':lb3': 2 });
  });
  it('adds the first-byte population when a streaming call was seen', () => {
    const s = emptyLatencyStats(); foldLatency(s, { e2eMs: 8019, ttfbMs: 4180 });
    const c = latencyAddClause(s);
    expect(c.clause).toContain('ttfbCount :tc, ttfbSumMs :ts, ttfbB5 :tb5');
    expect(c.values[':tc']).toBe(1); expect(c.values[':ts']).toBe(4180); expect(c.values[':tb5']).toBe(1);
  });
  it('placeholders never collide with the writers\' existing :i :o :cr :cw :n :p :m :d :u', () => {
    const s = emptyLatencyStats(); for (let i = 0; i < LATENCY_BUCKET_COUNT; i += 1) foldLatency(s, { e2eMs: 2 ** (i + 7), ttfbMs: 2 ** (i + 7) });
    const keys = Object.keys(latencyAddClause(s).values);
    for (const k of [':i', ':o', ':cr', ':cw', ':n', ':p', ':m', ':d', ':u']) expect(keys).not.toContain(k);
  });
});

describe('latencyFromItem', () => {
  it('round-trips what the clause wrote and reads absent attributes as zero', () => {
    const s = emptyLatencyStats(); foldLatency(s, { e2eMs: 8019, ttfbMs: 4180 }); foldLatency(s, { e2eMs: 30 });
    const { values } = latencyAddClause(s);
    // Simulate the item DynamoDB would hold after ADD from an empty item.
    const item: Record<string, unknown> = { pk: 'x', sk: 'y' };
    const nameFor = (ph: string) => ph.replace(/^:lb(\d+)$/, 'latB$1').replace(/^:tb(\d+)$/, 'ttfbB$1')
      .replace(':lc', 'latencyCount').replace(':ls', 'latencySumMs').replace(':tc', 'ttfbCount').replace(':ts', 'ttfbSumMs');
    for (const [ph, v] of Object.entries(values)) item[nameFor(ph)] = v;
    expect(latencyFromItem(item)).toEqual(s);
    expect(latencyFromItem({})).toEqual(emptyLatencyStats());
  });
  it('a second batch ADDed onto the item equals merging the two stats', () => {
    const a = emptyLatencyStats(); foldLatency(a, { e2eMs: 100, ttfbMs: 40 });
    const b = emptyLatencyStats(); foldLatency(b, { e2eMs: 5000 });
    const item: Record<string, unknown> = {};
    const apply = (s: typeof a) => { for (const [ph, v] of Object.entries(latencyAddClause(s).values)) {
      const k = ph.replace(/^:lb(\d+)$/, 'latB$1').replace(/^:tb(\d+)$/, 'ttfbB$1').replace(':lc', 'latencyCount').replace(':ls', 'latencySumMs').replace(':tc', 'ttfbCount').replace(':ts', 'ttfbSumMs');
      item[k] = ((item[k] as number) ?? 0) + v; } };
    apply(a); apply(b);
    const merged = emptyLatencyStats(); mergeLatency(merged, a); mergeLatency(merged, b);
    expect(latencyFromItem(item)).toEqual(merged);
  });
});

describe('latencyOnlyAdd', () => {
  it('is null with no samples and otherwise a standalone ADD expression', () => {
    expect(latencyOnlyAdd(emptyLatencyStats())).toBeNull();
    const s = emptyLatencyStats(); foldLatency(s, { e2eMs: 300 });
    expect(latencyOnlyAdd(s)).toEqual({ expression: 'ADD latencyCount :lc, latencySumMs :ls, latB1 :lb1', values: { ':lc': 1, ':ls': 300, ':lb1': 1 } });
  });
});

describe('latencyOnlyAddWithKeys', () => {
  it('SETs identifying attributes with if_not_exists ahead of the ADD, with disjoint placeholders', () => {
    const s = emptyLatencyStats(); foldLatency(s, { e2eMs: 300 });
    const u = latencyOnlyAddWithKeys(s, { day: '2026-06-04', projectId: 'untagged', modelId: 'm' })!;
    expect(u.expression).toBe('SET #k0 = if_not_exists(#k0, :k0), #k1 = if_not_exists(#k1, :k1), #k2 = if_not_exists(#k2, :k2) ADD latencyCount :lc, latencySumMs :ls, latB1 :lb1');
    expect(u.names).toEqual({ '#k0': 'day', '#k1': 'projectId', '#k2': 'modelId' });
    expect(u.values).toEqual({ ':lc': 1, ':ls': 300, ':lb1': 1, ':k0': '2026-06-04', ':k1': 'untagged', ':k2': 'm' });
    expect(latencyOnlyAddWithKeys(emptyLatencyStats(), { modelId: 'm' })).toBeNull();
  });
});
