import { billLinesFrom, parseUsageType } from './bill-parse';

// Every shape below is a real usage type from this account's Cost Explorer (2026-06 → 2026-10).
describe('parseUsageType', () => {
  it.each([
    ['USE1-anthropic.claude-fable-5-mantle-cache-write-tokens-standard', 'USE1', 'anthropic.claude-fable-5', 'cacheWrite5m', 'standard'],
    ['USE1-anthropic.claude-opus-5-5-mantle-cache-write-tokens-1h-standard', 'USE1', 'anthropic.claude-opus-5-5', 'cacheWrite1h', 'standard'],
    ['USE1-anthropic.claude-opus-5-5-mantle-cache-write-tokens-1h-global-standard', 'USE1', 'anthropic.claude-opus-5-5', 'cacheWrite1h', 'global'],
    // OpenAI's single 30-minute TTL (seen on the bill 2026-10-16; read as kind other until feature-46, which also made it a bogus Mantle model name)
    ['APS1-openai.gpt-6-luna-mantle-cache-write-tokens-30m-global-standard', 'APS1', 'openai.gpt-6-luna', 'cacheWrite30m', 'global'],
    ['USE1-openai.gpt-6-luna-mantle-cache-write-tokens-30m-standard', 'USE1', 'openai.gpt-6-luna', 'cacheWrite30m', 'standard'],
    ['USE1-anthropic.claude-opus-4-8-mantle-input-tokens-global-standard', 'USE1', 'anthropic.claude-opus-4-8', 'input', 'global'],
    ['USE1-anthropic.claude-fable-5-1-mantle-cache-read-tokens-standard', 'USE1', 'anthropic.claude-fable-5-1', 'cacheRead', 'standard'],
    ['USE1-anthropic.claude-opus-5-mantle-output-tokens-standard', 'USE1', 'anthropic.claude-opus-5', 'output', 'standard'],
    ['APS1-openai.gpt-6-luna-mantle-input-tokens-global-standard', 'APS1', 'openai.gpt-6-luna', 'input', 'global'],
    ['USE1-openai.gpt-5.6-luna-mantle-output-tokens-standard', 'USE1', 'openai.gpt-5.6-luna', 'output', 'standard'],
    ['USE1-Claude4.6Sonnet-cache-write-input-token-count', 'USE1', 'anthropic.claude-sonnet-4-6', 'cacheWrite5m', 'standard'],
    ['USE1-Claude4.6Sonnet-cache-read-input-token-count', 'USE1', 'anthropic.claude-sonnet-4-6', 'cacheRead', 'standard'],
    ['USE1-Claude4.6Sonnet-input-tokens-cross-region-global', 'USE1', 'anthropic.claude-sonnet-4-6', 'input', 'global'],
    ['USE1-Claude4.5Haiku-input-tokens', 'USE1', 'anthropic.claude-haiku-4-5', 'input', 'standard'],
    ['USE1-Claude4.6Opus-cache-write-input-token-count', 'USE1', 'anthropic.claude-opus-4-6', 'cacheWrite5m', 'standard'],
  ])('%s → %s / %s / %s / %s', (ut, region, model, kind, route) => {
    expect(parseUsageType(ut)).toEqual({ region, model, kind, route });
  });

  it('keeps a line it cannot classify as kind "other" instead of dropping it', () => {
    expect(parseUsageType('USE1-DeepSeek-R1-input-tokens')).toMatchObject({ region: 'USE1', kind: 'other', route: 'unknown' });
    expect(parseUsageType('USE1-NovaMicro-ProvisionedThroughput-1month-ModelUnits')).toMatchObject({ kind: 'other' });
    expect(parseUsageType('Something-without-region')).toMatchObject({ region: '', kind: 'other' });
  });

  it('the legacy and current names of one model resolve to the same card key', () => {
    // The rate card matches by substring; both must land on the 'sonnet' family row.
    expect(parseUsageType('USE1-Claude4.6Sonnet-input-tokens').model).toContain('sonnet-4-6');
    expect(parseUsageType('USE1-anthropic.claude-sonnet-4-6-mantle-input-tokens-standard').model).toContain('sonnet-4-6');
  });
});

describe('billLinesFrom', () => {
  const ce = [{
    TimePeriod: { Start: '2026-10-12', End: '2026-10-13' }, Estimated: true,
    Groups: [
      { Keys: ['USE1-anthropic.claude-opus-5-5-mantle-output-tokens-standard'], Metrics: { UnblendedCost: { Amount: '260.5242' }, UsageQuantity: { Amount: '11842.01' } } },
      { Keys: ['USE1-anthropic.claude-opus-5-5-mantle-input-tokens-global-standard'], Metrics: { UnblendedCost: { Amount: '0' }, UsageQuantity: { Amount: '0' } } }, // CE zero row
      { Keys: ['USE1-openai.gpt-6-luna-mantle-output-tokens-standard'], Metrics: { UnblendedCost: { Amount: '0' }, UsageQuantity: { Amount: '516' } } }, // used but $0 billed
    ],
  }];
  it('emits one line per non-zero group with the day, the parse and the Estimated flag', () => {
    const lines = billLinesFrom(ce);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ day: '2026-10-12', model: 'anthropic.claude-opus-5-5', kind: 'output', route: 'standard', usd: 260.5242, qty: 11842.01, estimated: true });
    expect(lines[1]).toMatchObject({ model: 'openai.gpt-6-luna', usd: 0, qty: 516 }); // quantity without dollars is still a line
  });
});
