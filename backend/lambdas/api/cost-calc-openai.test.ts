import { computeModelCost, matchRate, normalizeModelId } from './cost-calc';

/** Regression for the QA finding: OpenAI-on-Bedrock usage priced to $0.00. */
describe('OpenAI-on-Bedrock rates', () => {
  it('gpt-5.6-sol matches a non-zero rate after normalization', () => {
    const id = normalizeModelId('us.openai.gpt-5.6-sol');
    const rate = matchRate(id);
    expect(rate.key).toBe('gpt-5.6-sol');
    expect(rate.inPerToken).toBeGreaterThan(0);
    // 46,625 in + 4,314,612 out (the flagged numbers) must price well above zero:
    const c = computeModelCost({ modelId: id, inputTokens: 46_625, outputTokens: 4_314_612, cacheReadTokens: 0 });
    expect(c.estimatedUsd).toBeCloseTo(46_625 * 0.00000125 + 4_314_612 * 0.00001, 6);
    expect(c.estimatedUsd).toBeGreaterThan(43);
  });
  it('generic gpt-5 fallback exists and anthropic keys are unaffected', () => {
    expect(matchRate('openai.gpt-5-mini').key).toBe('gpt-5');
    expect(matchRate('us.anthropic.claude-sonnet-4-6').key).toBe('sonnet');
  });
});
