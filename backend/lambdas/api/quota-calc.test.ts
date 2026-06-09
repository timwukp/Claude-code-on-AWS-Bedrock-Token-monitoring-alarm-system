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
  it('excludes bedrock-mantle endpoint and latency-optimized quotas', () => {
    expect(windowOf('[bedrock-mantle endpoint] Input tokens per minute for Claude Opus 4.8')).toBeNull();
    expect(windowOf('Model invocation max latency-optimized tokens per day for Amazon Nova Pro V1')).toBeNull();
  });
});

import { modelKeywords, matchQuotaForModel } from './quota-calc';

describe('modelKeywords', () => {
  it('strips region/provider/version and keeps model + version-number keywords', () => {
    expect(modelKeywords('us.anthropic.claude-opus-4-8')).toEqual(['claude', 'opus', '4', '8']);
  });
  it('drops date stamps and ":0" suffixes', () => {
    expect(modelKeywords('us.anthropic.claude-haiku-4-5-20251001-v1:0')).toEqual(['claude', 'haiku', '4', '5']);
  });
  it('handles non-anthropic ids', () => {
    expect(modelKeywords('amazon.nova-micro-v1:0')).toEqual(['nova', 'micro']);
  });
});

describe('matchQuotaForModel', () => {
  const quotas = [
    { name: 'On-demand model inference tokens per minute for Anthropic Claude Opus 4.8', limit: 30_000_000, window: 'minute' as const, adjustable: true },
    { name: 'On-demand model inference tokens per minute for Anthropic Claude Haiku 4.5', limit: 100_000_000, window: 'minute' as const, adjustable: true },
    { name: 'Model invocation max tokens per day for Anthropic Claude Opus 4.8', limit: 21_600_000_000, window: 'day' as const, adjustable: false },
  ];
  it('matches Opus 4.8 to its per-minute quota', () => {
    const q = matchQuotaForModel(quotas, 'us.anthropic.claude-opus-4-8', 'minute');
    expect(q?.limit).toBe(30_000_000);
  });
  it('matches Opus 4.8 to its per-day quota', () => {
    const q = matchQuotaForModel(quotas, 'us.anthropic.claude-opus-4-8', 'day');
    expect(q?.limit).toBe(21_600_000_000);
  });
  it('does not mis-match a model with no corresponding quota', () => {
    expect(matchQuotaForModel(quotas, 'amazon.nova-micro-v1:0', 'minute')).toBeNull();
  });
});
