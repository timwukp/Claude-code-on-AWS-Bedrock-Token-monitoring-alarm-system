import { matchRate, computeModelCost, summarizeCosts } from './cost-calc';

const OPUS = 'arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.anthropic.claude-opus-4-8';
const FABLE = 'us.anthropic.claude-fable-5';
const FABLE_GLOBAL = 'global.anthropic.claude-fable-5';
const OPUS_BARE    = 'us.anthropic.claude-opus-4-8';

describe('matchRate', () => {
  it('matches opus-4-8 to the Opus rate', () => {
    expect(matchRate(OPUS).inPerToken).toBe(0.000005);
  });
  it('opus rate includes a defined cacheReadPerToken (not undefined)', () => {
    expect(matchRate(OPUS).cacheReadPerToken).toBe(0.0000005); // 0.1 × inPerToken
  });
  it('matches fable-5 to a non-zero rate (pricing entry must exist)', () => {
    expect(matchRate(FABLE).inPerToken).toBeGreaterThan(0);
    expect(matchRate(FABLE).outPerToken).toBeGreaterThan(0);
  });
  it('matches sonnet', () => {
    expect(matchRate('anthropic.claude-sonnet-4-6').outPerToken).toBe(0.000015);
  });
  it('returns zero rate for unknown models (cost shows 0, never wrong)', () => {
    const r = matchRate('some.unknown.model');
    expect(r.inPerToken).toBe(0);
    expect(r.cacheReadPerToken).toBe(0);
  });
});

describe('computeModelCost', () => {
  it('prices input + output + cache-read at the model rate', () => {
    const c = computeModelCost({ modelId: OPUS, inputTokens: 1000, outputTokens: 1000, cacheReadTokens: 0 });
    // 1000*5e-6 + 1000*25e-6 = 0.005 + 0.025 = 0.03
    expect(c.estimatedUsd).toBeCloseTo(0.03, 9);
    expect(c.cacheSavingsUsd).toBe(0);
  });

  it('computes cache savings = full-input price minus 0.1x cache price', () => {
    // 1,000,000 cache-read tokens on Opus: full input = 1e6*5e-6 = $5.00; actual = 1e6*5e-7 = $0.50
    const c = computeModelCost({ modelId: OPUS, inputTokens: 0, outputTokens: 0, cacheReadTokens: 1_000_000 });
    expect(c.cacheSavingsUsd).toBeCloseTo(4.5, 6); // $5.00 - $0.50
    expect(c.estimatedUsd).toBeCloseTo(0.5, 6);    // only the 0.1x charge
  });

  it('handles missing token fields as zero', () => {
    const c = computeModelCost({ modelId: OPUS });
    expect(c.estimatedUsd).toBe(0);
    expect(c.cacheSavingsUsd).toBe(0);
  });
});

describe('summarizeCosts', () => {
  it('totals estimated cost and cache savings across models', () => {
    const s = summarizeCosts([
      { modelId: OPUS, inputTokens: 0, outputTokens: 0, cacheReadTokens: 1_000_000 },
      { modelId: 'anthropic.claude-haiku-4-5', inputTokens: 1000, outputTokens: 0, cacheReadTokens: 0 },
    ]);
    expect(s.byModel).toHaveLength(2);
    expect(s.totalCacheSavingsUsd).toBeCloseTo(4.5, 6);
    // Opus 0.5 (cache) + Haiku 1000*1e-6 = 0.001 → 0.501
    expect(s.totalEstimatedUsd).toBeCloseTo(0.501, 6);
    // gross (pre-savings) must NOT be used as "Estimated spend" KPI; net ≠ gross
    expect(s.totalEstimatedUsd).not.toBeCloseTo(s.totalEstimatedUsd + s.totalCacheSavingsUsd, 2);
  });
});
