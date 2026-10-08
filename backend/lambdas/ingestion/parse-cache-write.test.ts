import {
  CacheWriteCounters, aggregate, aggregateByProject, aggregateByProjectDay, cacheWriteTtlOf, detectRunaways,
  foldCacheWrite, mergeCacheWrite, parseLogFile,
} from './parse';

/**
 * Shapes copied from real logged records (2026-10-05, four sampled; ids synthetic). The Anthropic
 * body carries `usage.cache_creation.{ephemeral_5m_input_tokens, ephemeral_1h_input_tokens}`:
 * for InvokeModelWithResponseStream on the FIRST chunk (`message_start`) under `message.usage`,
 * for InvokeModel on the object itself. On all four the 5 m figure equalled the record's own
 * `cacheWriteInputTokenCount` and 1 h was 0.
 */
const base = (over: Record<string, unknown> = {}) => ({
  timestamp: '2026-10-05T02:14:09Z', requestId: 'r1', modelId: 'us.anthropic.claude-opus-5-5',
  identity: { arn: 'arn:aws:iam::111122223333:user/dev' },
  input: { inputTokenCount: 3, cacheReadInputTokenCount: 41_020, cacheWriteInputTokenCount: 5_587 },
  output: { outputTokenCount: 120 },
  ...over,
});
const streamBody = (m5: number, h1: number) => [
  { type: 'message_start', message: { id: 'msg_x', role: 'assistant', usage: { input_tokens: 3, cache_creation_input_tokens: m5 + h1,
    cache_read_input_tokens: 41_020, cache_creation: { ephemeral_5m_input_tokens: m5, ephemeral_1h_input_tokens: h1 }, output_tokens: 1 } } },
  { type: 'content_block_start' }, { type: 'content_block_delta' }, { type: 'message_stop' },
  { 'amazon-bedrock-invocationMetrics': { inputTokenCount: 3, outputTokenCount: 120, invocationLatency: 3100, firstByteLatency: 900 } },
];
const invokeBody = (m5: number, h1: number) => ({
  id: 'msg_y', type: 'message', role: 'assistant', usage: { input_tokens: 3, cache_creation_input_tokens: m5 + h1,
    cache_read_input_tokens: 41_020, cache_creation: { ephemeral_5m_input_tokens: m5, ephemeral_1h_input_tokens: h1 }, output_tokens: 120 },
  'amazon-bedrock-invocationMetrics': { invocationLatency: 2400 },
});
const converseBody = (details: { ttl: string; inputTokens: number }[]) => ({
  output: { message: { role: 'assistant', content: [{ text: 'ok' }] } }, stopReason: 'end_turn',
  usage: { inputTokens: 3, outputTokens: 120, cacheReadInputTokens: 41_020, cacheWriteInputTokens: 5_587, cacheDetails: details },
});
const withBody = (body: unknown, over: Record<string, unknown> = {}) =>
  base({ output: { outputTokenCount: 120, outputBodyJson: body }, ...over });

describe('cacheWriteTtlOf', () => {
  it('reads the 5 m / 1 h split from the first chunk of a streaming body', () => {
    expect(cacheWriteTtlOf(withBody(streamBody(5_587, 0)) as any)).toEqual({ m5: 5_587, h1: 0 });
  });
  it('reads it from the object body of an InvokeModel call', () => {
    expect(cacheWriteTtlOf(withBody(invokeBody(5_000, 587)) as any)).toEqual({ m5: 5_000, h1: 587 });
  });
  it('sums Converse cacheDetails by ttl', () => {
    const r = withBody(converseBody([{ ttl: '5m', inputTokens: 1_000 }, { ttl: '1h', inputTokens: 4_587 }]));
    expect(cacheWriteTtlOf(r as any)).toEqual({ m5: 1_000, h1: 4_587 });
  });
  it('is {0,0} — known, not unknown — when the record wrote nothing to the cache', () => {
    const r = base({ input: { inputTokenCount: 3, cacheWriteInputTokenCount: 0 } });
    expect(cacheWriteTtlOf(r as any)).toEqual({ m5: 0, h1: 0 });
    expect(cacheWriteTtlOf(base({ input: { inputTokenCount: 3 } }) as any)).toEqual({ m5: 0, h1: 0 });
  });
  it('is null (unknown) when the body was not logged or carries no split', () => {
    expect(cacheWriteTtlOf(base() as any)).toBeNull();
    expect(cacheWriteTtlOf(withBody([{ type: 'message_start', message: { usage: { input_tokens: 3 } } }]) as any)).toBeNull();
    expect(cacheWriteTtlOf(withBody([]) as any)).toBeNull();
    expect(cacheWriteTtlOf(withBody('not an object') as any)).toBeNull();
  });
  it('is null when the split does not sum to the record\'s own cache-write count', () => {
    expect(cacheWriteTtlOf(withBody(streamBody(5_000, 0)) as any)).toBeNull(); // 5,000 ≠ 5,587
    expect(cacheWriteTtlOf(withBody(streamBody(5_587, 1)) as any)).toBeNull(); // 5,588 ≠ 5,587
  });
  it('is null on a non-numeric, negative or unknown-ttl figure', () => {
    const bad = (cc: unknown) => withBody([{ type: 'message_start', message: { usage: { cache_creation: cc } } }]);
    expect(cacheWriteTtlOf(bad({ ephemeral_5m_input_tokens: '5587', ephemeral_1h_input_tokens: 0 }) as any)).toBeNull();
    expect(cacheWriteTtlOf(bad({ ephemeral_5m_input_tokens: 5_588, ephemeral_1h_input_tokens: -1 }) as any)).toBeNull();
    expect(cacheWriteTtlOf(withBody(converseBody([{ ttl: '2h', inputTokens: 5_587 }])) as any)).toBeNull();
  });
});

describe('parseLogFile lifts the TTL split and discards the body', () => {
  it('stores cacheWriteTtl on the record and deletes outputBodyJson', () => {
    const [r] = parseLogFile(JSON.stringify(withBody(streamBody(5_587, 0))));
    expect(r.cacheWriteTtl).toEqual({ m5: 5_587, h1: 0 });
    expect(r.output && 'outputBodyJson' in r.output).toBe(false);
  });
  it('stores null when the body carried no split', () => {
    const [r] = parseLogFile(JSON.stringify(base()));
    expect(r.cacheWriteTtl).toBeNull();
  });
});

describe('cache-write counters on the aggregates', () => {
  const known = withBody(streamBody(5_587, 0));
  const unknown = base({ requestId: 'r2' }); // body not logged → total only
  const oneHour = withBody(invokeBody(0, 300), { requestId: 'r3', input: { inputTokenCount: 1, cacheWriteInputTokenCount: 300 } });
  const records = parseLogFile([known, unknown, oneHour].map((r) => JSON.stringify(r)).join('\n'));

  it('every rollup carries total, 5 m and 1 h; the remainder is the unknown-TTL count', () => {
    const expectCounters = (c: CacheWriteCounters) => {
      expect(c.cacheWriteTokens).toBe(5_587 + 5_587 + 300);
      expect(c.cacheWrite5mTokens).toBe(5_587);
      expect(c.cacheWrite1hTokens).toBe(300);
    };
    expectCounters([...aggregate(records).values()][0]);
    expectCounters([...aggregateByProject(records).values()][0]);
    expectCounters([...aggregateByProjectDay(records).values()][0]);
  });
  it('is idempotent across duplicate requestIds', () => {
    const twice = parseLogFile([known, known].map((r) => JSON.stringify(r)).join('\n'));
    const [a] = [...aggregate(twice).values()];
    expect(a.cacheWriteTokens).toBe(5_587);
    expect(a.cacheWrite5mTokens).toBe(5_587);
  });
  it('foldCacheWrite falls back to reading the body when the record was not pre-parsed', () => {
    const c: CacheWriteCounters = { cacheWriteTokens: 0, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0 };
    foldCacheWrite(c, known as any); // cacheWriteTtl undefined → derive now
    expect(c).toEqual({ cacheWriteTokens: 5_587, cacheWrite5mTokens: 5_587, cacheWrite1hTokens: 0 });
  });
  it('mergeCacheWrite adds all three', () => {
    const t: CacheWriteCounters = { cacheWriteTokens: 1, cacheWrite5mTokens: 1, cacheWrite1hTokens: 0 };
    mergeCacheWrite(t, { cacheWriteTokens: 10, cacheWrite5mTokens: 4, cacheWrite1hTokens: 6 });
    expect(t).toEqual({ cacheWriteTokens: 11, cacheWrite5mTokens: 5, cacheWrite1hTokens: 6 });
  });
});

describe('detectRunaways prices the cache writes too', () => {
  it('passes the record\'s cache-write counters to the pricing function', () => {
    const seen: CacheWriteCounters[] = [];
    const price = (_m: string, _i: number, _o: number, _c: number, cw: CacheWriteCounters) => { seen.push(cw); return 100; };
    const hits = detectRunaways(parseLogFile(JSON.stringify(withBody(streamBody(5_587, 0)))), undefined, 50, price);
    expect(hits).toHaveLength(1);
    expect(seen).toEqual([{ cacheWriteTokens: 5_587, cacheWrite5mTokens: 5_587, cacheWrite1hTokens: 0 }]);
  });
  it('a request that is only expensive because of its cache writes is flagged', () => {
    // 10M cache-write tokens at a 5 m rate of $6.25/MTok = $62.50 > $50; input/output alone ≈ $0
    const r = withBody(streamBody(10_000_000, 0), { input: { inputTokenCount: 1, cacheWriteInputTokenCount: 10_000_000 } });
    const price = (_m: string, i: number, o: number, c: number, cw: CacheWriteCounters) =>
      i * 5e-6 + o * 25e-6 + c * 5e-7 + cw.cacheWrite5mTokens * 6.25e-6 + cw.cacheWrite1hTokens * 1e-5
      + (cw.cacheWriteTokens - cw.cacheWrite5mTokens - cw.cacheWrite1hTokens) * 6.25e-6;
    const hits = detectRunaways(parseLogFile(JSON.stringify(r)), undefined, 50, price);
    expect(hits).toHaveLength(1);
    expect(hits[0].estimatedUsd).toBeCloseTo(62.5, 1);
  });
});
