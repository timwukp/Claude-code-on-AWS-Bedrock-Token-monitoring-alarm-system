import { billModelKey, buildBill, mantleConsistent, BillLineItem, MantleCounts } from './bill-calc';

// The Opus 5.5 window that exposed the gap (2026-10-06 → 10-13), scaled to round numbers.
const W = { from: '2026-10-06', to: '2026-10-13' };
const line = (day: string, model: string, kind: string, usd: number, route = 'standard'): BillLineItem => ({ day, model, kind, route, usd, qty: 0 });

describe('billModelKey', () => {
  it('maps every route and the profile-resolved bare id of one model onto the card key', () => {
    for (const id of ['us.anthropic.claude-opus-5-5', 'global.anthropic.claude-opus-5-5', 'anthropic.claude-opus-5-5',
      'arn:aws:bedrock:us-east-1:111122223333:inference-profile/us.anthropic.claude-opus-5-5']) {
      expect(billModelKey(id)).toBe('opus-5-5');
    }
  });
  it('legacy bill names resolve to the same key as the logs\' ids', () => {
    expect(billModelKey('anthropic.claude-sonnet-4-6')).toBe('sonnet');
    expect(billModelKey('us.anthropic.claude-sonnet-4-6')).toBe('sonnet');
  });
  it('an unknown model keeps its normalized id as the key', () => {
    expect(billModelKey('openai.gpt-6-luna')).toBe('openai.gpt-6-luna');
  });
});

describe('buildBill', () => {
  const lines = [
    line('2026-10-06', 'anthropic.claude-opus-5-5', 'cacheRead', 400),
    line('2026-10-07', 'anthropic.claude-opus-5-5', 'cacheWrite5m', 500),
    line('2026-10-07', 'anthropic.claude-opus-5-5', 'cacheWrite1h', 100),
    line('2026-10-08', 'anthropic.claude-opus-5-5', 'output', 200),
    line('2026-10-08', 'anthropic.claude-opus-5-5', 'input', 48),
    line('2026-10-08', 'anthropic.claude-opus-5-5', 'input', 2, 'global'),
    line('2026-10-08', 'anthropic.claude-fable-5', 'input', 300, 'global'),
    line('2026-10-20', 'anthropic.claude-fable-5', 'input', 999),          // outside the window → ignored
    line('2026-10-08', 'DeepSeek-R1', 'other', 1.41),
  ];
  const logged = new Map<string, Map<string, number>>([
    ['us.anthropic.claude-opus-5-5', new Map([['2026-10-06', 150], ['2026-10-07', 200], ['2026-10-08', 100], ['2026-10-09', 50]])], // 10-09 has no bill yet → excluded
    ['global.anthropic.claude-fable-5', new Map([['2026-10-08', 320]])],   // we estimate ABOVE the bill
  ]);
  const mantle = new Map<string, MantleCounts>([['anthropic.claude-opus-5-5', { inferences: 5816, clientErrors: 2, inputTokens: 1_574_987_404, outputTokens: 8_112_548 }]]);
  const b = buildBill(lines, logged, mantle, W, '2026-10-14T05:00:00Z');

  it('counts only the days the bill covers inside the window', () => {
    expect(b.window).toEqual({ from: W.from, to: W.to, daysBilled: 3, billedFrom: '2026-10-06', billedTo: '2026-10-08' });
  });
  it('sums billed by model and by kind, folding both cache-write TTLs into cacheWrite', () => {
    const o = b.byModel.find((r) => r.model === 'opus-5-5')!;
    expect(o.billedUsd).toBe(1250);
    expect(o.byKind).toEqual({ input: 50, output: 200, cacheRead: 400, cacheWrite: 600, other: 0 });
  });
  it('unlogged = billed − the logged estimate on the SAME days (10-09 excluded)', () => {
    const o = b.byModel.find((r) => r.model === 'opus-5-5')!;
    expect(o.loggedEstimateUsd).toBe(450);
    expect(o.unloggedUsd).toBe(800);
    expect(o.overEstimated).toBeUndefined();
    expect(o.mantle).toEqual({ inferences: 5816, inputTokens: 1_574_987_404, outputTokens: 8_112_548 });
  });
  it('an estimate above the bill is floored at 0 and FLAGGED, never netted against other models', () => {
    const f = b.byModel.find((r) => r.model === 'fable-5')!;
    expect(f.billedUsd).toBe(300); expect(f.loggedEstimateUsd).toBe(320);
    expect(f.unloggedUsd).toBe(0); expect(f.overEstimated).toBe(true); expect(f.mantle).toBeNull();
    expect(b.totalUnloggedUsd).toBe(801.41); // 800 (opus) + 1.41 (the unpriced DeepSeek line) — not netted by fable's −20
  });
  it('totals and the logged share', () => {
    expect(b.totalBilledUsd).toBe(1551.41);
    expect(b.totalLoggedEstimateUsd).toBe(770);
    expect(b.loggedSharePct).toBe(49.6);
    expect(b.dollarsSource).toBe('cost-explorer'); expect(b.tokensSource).toBe('cloudwatch');
    expect(b.byModel[0].model).toBe('opus-5-5'); // sorted by billed
    expect(b.byModel.find((r) => r.model === 'DeepSeek-R1')!.byKind.other).toBe(1.41); // unknown model: key = its id as billed
  });
  it('carries the viewer tenant\'s share on the same billed days and names the scope (qa F-PR73-001)', () => {
    const tenant = new Map([['2026-10-06', 100], ['2026-10-08', 50], ['2026-10-09', 999]]); // 10-09 is not billed yet → excluded
    const t = buildBill(lines, logged, mantle, W, null, tenant);
    expect(t.scope).toBe('account');
    expect(t.tenantLoggedEstimateUsd).toBe(150);
    expect(buildBill(lines, logged, mantle, W, null).tenantLoggedEstimateUsd).toBeNull();
    expect(t.note).toMatch(/Account-wide/);
  });
  it('an empty window yields a null share and no rows', () => {
    const e = buildBill(lines, logged, new Map(), { from: '2026-11-01', to: '2026-11-30' }, null); // the caller fetches Mantle for the window, so it is empty too
    expect(e.byModel).toEqual([]); expect(e.loggedSharePct).toBeNull(); expect(e.window).toEqual({ from: '2026-11-01', to: '2026-11-30', daysBilled: 0, billedFrom: null, billedTo: null });
  });
});

describe('mantleConsistent', () => {
  const per = new Map<string, MantleCounts>([['a', { inferences: 5000, clientErrors: 0, inputTokens: 0, outputTokens: 0 }], ['b', { inferences: 816, clientErrors: 0, inputTokens: 0, outputTokens: 0 }]]);
  it('agrees when the Model series sum to the fleet series within 1%', () => {
    expect(mantleConsistent(per, 5816)).toBe(true);
    expect(mantleConsistent(per, 5870)).toBe(true);
  });
  it('flags a gap larger than 1% (a missed or double-counted series)', () => {
    expect(mantleConsistent(per, 6500)).toBe(false);
    expect(mantleConsistent(new Map(), 100)).toBe(false);
    expect(mantleConsistent(new Map(), 0)).toBe(true);
  });
});
