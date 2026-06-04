import { computeHeadroom, summarizeThrottles, windowOf, QuotaInfo } from './quota-calc';

const TPM: QuotaInfo = { name: 'tokens per minute for Opus', limit: 30_000_000, window: 'minute', adjustable: true };

describe('computeHeadroom', () => {
  it('computes remaining + percent for normal usage', () => {
    const h = computeHeadroom(TPM, 6_000_000); // 20%
    expect(h.remaining).toBe(24_000_000);
    expect(h.usedPct).toBe(20);
    expect(h.status).toBe('ok');
  });

  it('flags warn at >=70% and critical at >=90%', () => {
    expect(computeHeadroom(TPM, 21_000_000).status).toBe('warn');      // 70%
    expect(computeHeadroom(TPM, 27_000_000).status).toBe('critical');  // 90%
  });

  it('never goes negative or over 100% even past the limit', () => {
    const h = computeHeadroom(TPM, 40_000_000); // over limit
    expect(h.remaining).toBe(0);
    expect(h.usedPct).toBe(100);
  });

  it('handles a zero/unknown limit safely', () => {
    const h = computeHeadroom({ ...TPM, limit: 0 }, 5);
    expect(h.usedPct).toBe(0);
    expect(h.remaining).toBe(0);
  });
});

describe('summarizeThrottles', () => {
  it('treats missing datapoints as zero (the normal, healthy case)', () => {
    // InvocationThrottles often has NO datapoints until a 429 actually occurs.
    const s = summarizeThrottles(undefined, undefined);
    expect(s.throttledCount).toBe(0);
    expect(s.throttled).toBe(false);
  });

  it('reports throttling when the count is positive', () => {
    const s = summarizeThrottles(5, 6);
    expect(s.throttled).toBe(true);
    expect(s.clientErrors).toBe(6);
  });
});

describe('windowOf', () => {
  it('classifies per-minute and per-day quota names', () => {
    expect(windowOf('Cross-region ... tokens per minute for X')).toBe('minute');
    expect(windowOf('Model invocation max tokens per day for X')).toBe('day');
    expect(windowOf('some unrelated quota')).toBeNull();
  });
});
