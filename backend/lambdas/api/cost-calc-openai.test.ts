import { collectUnpriced, computeModelCost, isPriced, matchRate, normalizeModelId, RATE_CARD } from './cost-calc';

/** Regression for the QA finding: OpenAI-on-Bedrock usage priced to $0.00 — and, feature-41, priced at the CARD's figures. */
describe('OpenAI-on-Bedrock rates', () => {
  it('gpt-5.6-sol prices at its model card (Global CRIS $4 / $20 per MTok), ×1.1 on the us. route', () => {
    const id = normalizeModelId('us.openai.gpt-5.6-sol');
    const rate = matchRate(id);
    expect(rate.key).toBe('gpt-5.6-sol');
    expect(rate.inPerToken * 1e6).toBeCloseTo(4, 9);
    expect(rate.outPerToken * 1e6).toBeCloseTo(20, 9);
    expect(rate.cacheReadPerToken * 1e6).toBeCloseTo(0.4, 9);
    // The August 2026 usage on this account: 46,625 in + 4,314,612 out + 1,477,708 cache-write tokens.
    const c = computeModelCost({ modelId: id, inputTokens: 46_625, outputTokens: 4_314_612, cacheReadTokens: 0, cacheWriteTokens: 1_477_708 });
    expect(c.routeMultiplier).toBe(1.1);
    expect(c.estimatedUsd).toBeCloseTo((46_625 * 4e-6 + 4_314_612 * 20e-6 + 1_477_708 * 5e-6) * 1.1, 6);
    expect(c.estimatedUsd).toBeGreaterThan(95); // the feature-36 row ($1.25 / $10) read $47.5 here — 3.2× under its card
  });

  // The six cards read 2026-10-23, Global CRIS, short context: input / output per MTok.
  const CARDS: Array<[string, number, number]> = [
    ['gpt-5.6-luna', 0.20, 1.20], ['gpt-5.6-sol', 4, 20], ['gpt-5.6-terra', 2, 12],
    ['gpt-6-astra', 10, 50], ['gpt-6-luna', 0.10, 0.50], ['gpt-6-sol', 2, 10],
  ];
  it.each(CARDS)('%s: card figures, cache read 0.1×, one 30-minute write TTL at 1.25× on both columns, two route tiers', (key, inM, outM) => {
    const r = matchRate(`openai.${key}`);
    expect(r.key).toBe(key);
    expect(r.inPerToken * 1e6).toBeCloseTo(inM, 9);
    expect(r.outPerToken * 1e6).toBeCloseTo(outM, 9);
    expect(r.cacheReadPerToken * 1e6).toBeCloseTo(inM * 0.1, 9);
    expect(r.cacheWrite5mPerToken * 1e6).toBeCloseTo(inM * 1.25, 9);
    expect(r.cacheWrite1hPerToken * 1e6).toBeCloseTo(inM * 1.25, 9);
    expect(r.routeTiers).toBe(true);
  });

  it('a point-release id never falls on a shorter key (qa F-PR73-N02: gpt-5.6-luna read as gpt-5)', () => {
    expect(matchRate('openai.gpt-5.6-luna').key).toBe('gpt-5.6-luna');
    expect(matchRate('us.openai.gpt-5.6-terra').key).toBe('gpt-5.6-terra');
    expect(matchRate('global.openai.gpt-6-luna').key).toBe('gpt-6-luna');
    expect(matchRate('arn:aws:bedrock:us-east-1:111122223333:inference-profile/us.openai.gpt-6-sol').key).toBe('gpt-6-sol');
    // Longest key wins regardless of card order: a reversed card gives the same answers.
    const reversed = [...RATE_CARD].reverse();
    for (const id of ['anthropic.claude-fable-5-1', 'anthropic.claude-fable-5', 'anthropic.claude-opus-5-5', 'anthropic.claude-sonnet-5-5', 'openai.gpt-5.6-sol']) {
      expect(matchRate(id, reversed).key).toBe(matchRate(id).key);
    }
  });

  it('no generic gpt-5 row: an unknown GPT id is unpriced and reported, not priced at a guess', () => {
    expect(isPriced('openai.gpt-5-mini')).toBe(false);
    expect(isPriced('openai.gpt-9-nebula')).toBe(false);
    expect(isPriced('us.anthropic.claude-sonnet-4-6')).toBe(true);
    const un = collectUnpriced([
      { modelId: 'arn:aws:bedrock:us-east-1:111122223333:inference-profile/openai.gpt-5-mini', inputTokens: 10, outputTokens: 5, invocations: 1 },
      { modelId: 'openai.gpt-5-mini', outputTokens: 20, invocations: 2 },
      { modelId: 'openai.gpt-6-luna', inputTokens: 1_000, outputTokens: 1_000, invocations: 3 }, // priced → not listed
      { modelId: 'amazon.nova-pro-v1:0', inputTokens: 500, invocations: 1 },
      { modelId: 'something-with-no-usage', inputTokens: 0, outputTokens: 0, invocations: 4 },     // zero usage → dropped
    ]);
    expect(un).toEqual([
      { modelId: 'amazon.nova-pro-v1:0', inputTokens: 500, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, invocations: 1 },
      { modelId: 'openai.gpt-5-mini', inputTokens: 10, outputTokens: 25, cacheReadTokens: 0, cacheWriteTokens: 0, invocations: 3 },
    ]);
  });

  it('gpt-oss rows come from the Price List: one tier, no cache charges', () => {
    const r = matchRate('openai.gpt-oss-20b-1:0');
    expect(r.key).toBe('gpt-oss-20b');
    expect(r.inPerToken * 1e6).toBeCloseTo(0.07, 9); expect(r.outPerToken * 1e6).toBeCloseTo(0.3, 9);
    expect(r.routeTiers).toBe(false); expect(r.cacheReadPerToken).toBe(0); expect(r.cacheWrite5mPerToken).toBe(0);
    expect(matchRate('openai.gpt-oss-120b').inPerToken * 1e6).toBeCloseTo(0.15, 9);
  });
});
