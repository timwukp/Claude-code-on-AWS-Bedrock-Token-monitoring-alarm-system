import { foldMantle, mantleModelsToQuery, MantleDay } from './mantle-metrics';

describe('mantleModelsToQuery — discovery that does not forget (feature-46, qa F-PR77)', () => {
  it('unions what CloudWatch lists now, what was stored before, and what the bill names', () => {
    const models = mantleModelsToQuery(
      ['openai.gpt-6-luna'],                                   // all ListMetrics shows two weeks after opus went quiet
      ['anthropic.claude-opus-5-5', 'openai.gpt-6-luna'],      // the persisted inventory
      ['anthropic.claude-opus-5-5', 'openai.gpt-5.6-luna', 'Claude4.6Sonnet', 'guardrail-contentpolicyunitsconsumed', 'deepseek-r1-output-tokens', 'openai.gpt-6-luna-mantle-cache-write-tokens-30m-standard'],
    );
    expect(models).toEqual(['anthropic.claude-opus-5-5', 'openai.gpt-5.6-luna', 'openai.gpt-6-luna']);
  });
  it('is empty when nothing is known', () => { expect(mantleModelsToQuery([], [], [])).toEqual([]); });
});

describe('foldMantle', () => {
  const rows: MantleDay[] = [
    { day: '2026-10-08', model: 'anthropic.claude-opus-5-5', inferences: 2830, clientErrors: 0, inputTokens: 900, outputTokens: 90 },
    { day: '2026-10-09', model: 'anthropic.claude-opus-5-5', inferences: 2146, clientErrors: 2, inputTokens: 600, outputTokens: 60 },
    { day: '2026-10-09', model: 'openai.gpt-6-luna', inferences: 10, clientErrors: 0, inputTokens: 5, outputTokens: 50 },
  ];
  it('sums per model across days and reports the fleet and the days covered', () => {
    const r = foldMantle(rows, new Map([['2026-10-08', 2830], ['2026-10-09', 2156]]));
    expect(r.perModel.get('anthropic.claude-opus-5-5')).toEqual({ inferences: 4976, clientErrors: 2, inputTokens: 1500, outputTokens: 150 });
    expect(r.perModel.get('openai.gpt-6-luna')!.inferences).toBe(10);
    expect(r.fleetInferences).toBe(4986);
    expect(r.clientErrors).toBe(2);
    expect(r.daysStored).toEqual(['2026-10-08', '2026-10-09']);
  });
  it('a day with a fleet value but no model rows still counts as stored (the collector saw the day)', () => {
    const r = foldMantle([], new Map([['2026-10-20', 0]]));
    expect(r.daysStored).toEqual(['2026-10-20']); expect(r.perModel.size).toBe(0); expect(r.fleetInferences).toBe(0);
  });
});
