import {
  LATENCY_BUCKET_COUNT, LATENCY_BUCKET_EDGES_MS, aggregate, aggregateByProject, aggregateByProjectDay,
  bucketIndex, emptyLatencyStats, foldLatency, latencyOf, mergeLatency, parseLogFile, percentileFromBuckets,
} from './parse';

// Shape copied from a real logged record (2026-09-23): streaming bodies are an array of chunks and
// the metrics ride in the LAST one; non-streaming bodies are a single object.
const METRICS = { inputTokenCount: 2, outputTokenCount: 418, invocationLatency: 8019, firstByteLatency: 4180,
  cacheReadInputTokenCount: 163334, cacheWriteInputTokenCount: 480 };
const streaming = (over: Record<string, unknown> = {}) => ({
  timestamp: '2026-09-23T03:59:42Z', requestId: 'r1', modelId: 'anthropic.claude-opus-5', identity: { arn: 'arn:aws:iam::1:user/u' },
  input: { inputTokenCount: 2 }, output: { outputTokenCount: 418, outputBodyJson: [{ type: 'message_start' }, { type: 'content_block_delta' }, { 'amazon-bedrock-invocationMetrics': METRICS }] },
  ...over,
});

describe('latencyOf', () => {
  it('reads invocationLatency and firstByteLatency from the last streaming chunk', () => {
    expect(latencyOf(streaming() as any)).toEqual({ e2eMs: 8019, ttfbMs: 4180 });
  });
  it('reads a non-streaming object body, which has no first-byte figure', () => {
    const r = streaming({ output: { outputTokenCount: 5, outputBodyJson: { 'amazon-bedrock-invocationMetrics': { invocationLatency: 1200 } } } });
    expect(latencyOf(r as any)).toEqual({ e2eMs: 1200 });
  });
  it('is null when the body was not logged, has no metrics, or the value is not a finite number', () => {
    expect(latencyOf(streaming({ output: { outputTokenCount: 1 } }) as any)).toBeNull();
    expect(latencyOf(streaming({ output: { outputTokenCount: 1, outputBodyJson: [{ type: 'x' }] } }) as any)).toBeNull();
    expect(latencyOf(streaming({ output: { outputTokenCount: 1, outputBodyJson: [{ 'amazon-bedrock-invocationMetrics': { invocationLatency: 'fast' } }] } }) as any)).toBeNull();
    expect(latencyOf(streaming({ output: { outputTokenCount: 1, outputBodyJson: [{ 'amazon-bedrock-invocationMetrics': { invocationLatency: -1 } }] } }) as any)).toBeNull();
    expect(latencyOf(streaming({ output: { outputTokenCount: 1, outputBodyJson: [] } }) as any)).toBeNull();
  });
  it('drops a non-numeric firstByteLatency but keeps e2e', () => {
    const r = streaming({ output: { outputTokenCount: 1, outputBodyJson: [{ 'amazon-bedrock-invocationMetrics': { invocationLatency: 900, firstByteLatency: null } }] } });
    expect(latencyOf(r as any)).toEqual({ e2eMs: 900 });
  });
});

describe('parseLogFile extract-then-discard', () => {
  it('lifts latency onto the record and deletes the body', () => {
    const [r] = parseLogFile(JSON.stringify(streaming()));
    expect(r.latency).toEqual({ e2eMs: 8019, ttfbMs: 4180 });
    expect(r.output).toEqual({ outputTokenCount: 418 });
    expect('outputBodyJson' in (r.output as object)).toBe(false);
  });
  it('records without a body parse as before, with latency null', () => {
    const [r] = parseLogFile(JSON.stringify(streaming({ output: { outputTokenCount: 7 } })));
    expect(r.latency).toBeNull();
    expect(r.output).toEqual({ outputTokenCount: 7 });
  });
});

describe('buckets', () => {
  it('has one more bucket than edges and places values on the closed upper edge', () => {
    expect(LATENCY_BUCKET_COUNT).toBe(LATENCY_BUCKET_EDGES_MS.length + 1);
    expect(bucketIndex(0)).toBe(0);
    expect(bucketIndex(250)).toBe(0);      // ≤ 250 → first bucket
    expect(bucketIndex(251)).toBe(1);
    expect(bucketIndex(64_000)).toBe(LATENCY_BUCKET_EDGES_MS.length - 1);
    expect(bucketIndex(64_001)).toBe(LATENCY_BUCKET_COUNT - 1); // open-ended
  });
  it('folds e2e and first-byte as separate populations and ignores null', () => {
    const s = emptyLatencyStats();
    foldLatency(s, { e2eMs: 8019, ttfbMs: 4180 });
    foldLatency(s, { e2eMs: 1200 });
    foldLatency(s, null);
    expect(s.latencyCount).toBe(2); expect(s.latencySumMs).toBe(9219);
    expect(s.ttfbCount).toBe(1); expect(s.ttfbSumMs).toBe(4180);
    expect(s.latencyBuckets[bucketIndex(8019)]).toBe(1);
    expect(s.latencyBuckets[bucketIndex(1200)]).toBe(1);
    expect(s.ttfbBuckets[bucketIndex(4180)]).toBe(1);
    expect(s.ttfbBuckets.reduce((a, b) => a + b, 0)).toBe(1);
  });
  it('merge is additive so batches can be combined without loss', () => {
    const a = emptyLatencyStats(); foldLatency(a, { e2eMs: 100, ttfbMs: 50 });
    const b = emptyLatencyStats(); foldLatency(b, { e2eMs: 100_000 });
    mergeLatency(a, b);
    expect(a.latencyCount).toBe(2); expect(a.latencySumMs).toBe(100_100);
    expect(a.latencyBuckets[0]).toBe(1); expect(a.latencyBuckets[LATENCY_BUCKET_COUNT - 1]).toBe(1);
    expect(a.ttfbCount).toBe(1);
  });
});

describe('percentileFromBuckets', () => {
  const fill = (...ms: number[]) => { const s = emptyLatencyStats(); for (const m of ms) foldLatency(s, { e2eMs: m }); return s.latencyBuckets; };
  it('is null with no samples', () => { expect(percentileFromBuckets(emptyLatencyStats().latencyBuckets, 0.5)).toBeNull(); });
  it('interpolates inside the bucket that holds the rank', () => {
    // 4 samples all in (1000, 2000]: p50 → rank 2 of 4 → halfway up the bucket = 1500
    expect(percentileFromBuckets(fill(1100, 1200, 1800, 1900), 0.5)).toBe(1500);
    // p100 → rank 4 of 4 → top of the bucket
    expect(percentileFromBuckets(fill(1100, 1200, 1800, 1900), 1)).toBe(2000);
  });
  it('walks across buckets by cumulative count', () => {
    // 9 in the first bucket, 1 in (4000, 8000]: p50 lands in the first, p95 (rank 10) in the second
    const b = fill(10, 20, 30, 40, 50, 60, 70, 80, 90, 5000);
    expect(percentileFromBuckets(b, 0.5)).toBeLessThanOrEqual(250);
    expect(percentileFromBuckets(b, 0.95)).toBe(8000);
  });
  it('returns the lower edge for the open-ended last bucket (an under-estimate, by design)', () => {
    expect(percentileFromBuckets(fill(70_000, 90_000), 0.5)).toBe(64_000);
  });
});

describe('aggregates carry latency', () => {
  const recs = [streaming(), streaming({ requestId: 'r2', output: { outputTokenCount: 1 } }), streaming({ requestId: 'r1' })] as any[];
  it('hourly, per-project and per-project-day all fold the same samples once, de-duped by requestId', () => {
    const parsed = parseLogFile(recs.map((r) => JSON.stringify(r)).join('\n'));
    for (const m of [aggregate(parsed), aggregateByProject(parsed), aggregateByProjectDay(parsed)]) {
      const [agg] = [...m.values()] as any[];
      expect(agg.invocations).toBe(2);           // r1 duplicate dropped
      expect(agg.latency.latencyCount).toBe(1);  // r2 had no body → unknown, not zero
      expect(agg.latency.latencySumMs).toBe(8019);
      expect(agg.latency.ttfbCount).toBe(1);
    }
  });
});
