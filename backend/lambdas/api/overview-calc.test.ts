import { buildOverview, windowBounds } from './overview-calc';
import { ModelRate } from './cost-calc';
import { ProjdayItem } from './project-calc';

// A flat card so expected dollars are easy to read: $1 per 1M input, $2 per 1M output, $0.1 per 1M cache.
const CARD: ModelRate[] = [
  { key: 'claude', inPerToken: 1e-6, outPerToken: 2e-6, cacheReadPerToken: 1e-7 },
];

const item = (day: string, projectId: string, inputTokens: number, outputTokens = 0, modelId = 'us.anthropic.claude-opus-5'): ProjdayItem =>
  ({ day, projectId, modelId, inputTokens, outputTokens, cacheReadTokens: 0, invocations: 1 });

describe('windowBounds', () => {
  it('splits a 7-day window into two equal, adjacent periods ending today', () => {
    const b = windowBounds(new Date('2026-09-18T15:00:00Z'), '7');
    expect(b).toMatchObject({ kind: '7', days: 7, from: '2026-09-12', to: '2026-09-18', priorFrom: '2026-09-05', priorTo: '2026-09-11' });
  });
  it('mtd compares the elapsed days with the same span of the previous month', () => {
    const b = windowBounds(new Date('2026-09-18T15:00:00Z'), 'mtd');
    expect(b).toMatchObject({ kind: 'mtd', days: 18, from: '2026-09-01', to: '2026-09-18', priorFrom: '2026-08-01', priorTo: '2026-08-18' });
  });
  it('mtd on the 1st is a one-day window against the 1st of last month', () => {
    const b = windowBounds(new Date('2026-10-01T02:00:00Z'), 'mtd');
    expect(b).toMatchObject({ days: 1, from: '2026-10-01', to: '2026-10-01', priorFrom: '2026-09-01', priorTo: '2026-09-01' });
  });
  it('mtd clamps the prior span to the previous month length (31 March vs 28 Feb)', () => {
    const b = windowBounds(new Date('2026-03-31T00:00:00Z'), 'mtd');
    expect(b.priorFrom).toBe('2026-02-01');
    expect(b.priorTo).toBe('2026-02-28');
  });
});

describe('buildOverview', () => {
  const now = new Date('2026-09-18T12:00:00Z');
  const b = windowBounds(now, '7'); // cur 09-12..09-18, prior 09-05..09-11

  it('prices current and prior periods separately and reports a signed delta', () => {
    const r = buildOverview([
      item('2026-09-13', 'alpha', 3_000_000),          // $3 current
      item('2026-09-16', 'alpha', 0, 1_000_000),       // $2 current
      item('2026-09-07', 'alpha', 1_000_000),          // $1 prior
      item('2026-09-01', 'alpha', 9_000_000),          // outside both windows — ignored
    ], b, new Map([['alpha', 'Alpha']]), CARD);
    expect(r.spend).toMatchObject({ currentUsd: 5, priorUsd: 1, deltaUsd: 4, deltaPct: 400 });
    expect(r.spend.tokens).toBe(4_000_000);
    expect(r.spend.priorTokens).toBe(1_000_000);
    expect(r.movers[0]).toMatchObject({ projectId: 'alpha', name: 'Alpha', currentUsd: 5, priorUsd: 1, deltaUsd: 4 });
  });

  it('deltaPct is null when the prior period is zero — never divide-by-zero into infinity', () => {
    const r = buildOverview([item('2026-09-13', 'alpha', 1_000_000)], b, new Map(), CARD);
    expect(r.spend.deltaPct).toBeNull();
    expect(r.movers[0].deltaPct).toBeNull();
  });

  it('zero-fills every day of the current window in the daily series', () => {
    const r = buildOverview([item('2026-09-13', 'alpha', 1_000_000)], b, new Map(), CARD);
    expect(r.spend.daily.map((d) => d.day)).toEqual(['2026-09-12', '2026-09-13', '2026-09-14', '2026-09-15', '2026-09-16', '2026-09-17', '2026-09-18']);
    expect(r.spend.daily[1]).toEqual({ day: '2026-09-13', usd: 1, tokens: 1_000_000 });
    expect(r.spend.daily[0]).toEqual({ day: '2026-09-12', usd: 0, tokens: 0 });
  });

  it('keeps regional variants of a model as separate byModel rows (the UI merges them) but sums them into spend', () => {
    const r = buildOverview([
      item('2026-09-13', 'alpha', 1_000_000, 0, 'us.anthropic.claude-opus-5'),
      item('2026-09-13', 'alpha', 1_000_000, 0, 'global.anthropic.claude-opus-5'),
    ], b, new Map(), CARD);
    expect(r.byModel).toHaveLength(2);
    expect(r.spend.currentUsd).toBe(2);
  });

  it('reports per-model cache savings for the current window only: full input rate minus cache-read rate', () => {
    const cached = (day: string, cacheReadTokens: number): ProjdayItem =>
      ({ ...item(day, 'alpha', 0), cacheReadTokens });
    const r = buildOverview([
      cached('2026-09-13', 10_000_000),   // current: $10 at the full input rate − $1 paid = $9 saved
      cached('2026-09-14', 10_000_000),   // current: another $9
      cached('2026-09-07', 50_000_000),   // prior — must not count
    ], b, new Map(), CARD);
    expect(r.byModel).toHaveLength(1);
    expect(r.byModel[0]).toMatchObject({ cacheReadTokens: 20_000_000, estimatedUsd: 2, cacheSavingsUsd: 18 });
  });

  it('ranks movers by absolute change and caps the list', () => {
    const items: ProjdayItem[] = [];
    for (let i = 0; i < 12; i++) items.push(item('2026-09-13', `p${i}`, (i + 1) * 1_000_000));
    const r = buildOverview(items, b, new Map(), CARD, 5);
    expect(r.movers).toHaveLength(5);
    expect(r.movers[0].projectId).toBe('p11');
    expect(r.movers.map((m) => Math.abs(m.deltaUsd))).toEqual([...r.movers.map((m) => Math.abs(m.deltaUsd))].sort((x, y) => y - x));
  });

  it('flags partial coverage when the earliest rollup day is inside the prior window, and when there is no data at all', () => {
    const partial = buildOverview([item('2026-09-08', 'alpha', 1), item('2026-09-13', 'alpha', 1)], b, new Map(), CARD);
    expect(partial.coverage).toEqual({ firstDayWithData: '2026-09-08', partial: true });
    const full = buildOverview([item('2026-09-01', 'alpha', 1), item('2026-09-13', 'alpha', 1)], b, new Map(), CARD);
    expect(full.coverage).toEqual({ firstDayWithData: '2026-09-01', partial: false });
    expect(buildOverview([], b, new Map(), CARD).coverage).toEqual({ firstDayWithData: null, partial: true });
  });
});
