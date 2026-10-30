import { evaluateQualityRows } from './quality-gate';

describe('quality gate', () => {
  const header = { Data: [{ VarCharValue: 'request_id' }, { VarCharValue: 'input_tokens' }] };

  it('passes when the quality query returns only its header row', () => {
    expect(evaluateQualityRows([header], 'quality_60_tokens_nonnegative')).toEqual({ pass: true, offending: 0, sample: [] });
  });

  it('fails with a readable sample when offending rows come back', () => {
    const v = evaluateQualityRows([header, { Data: [{ VarCharValue: 'r1' }, { VarCharValue: '-5' }] }], 'quality_60_tokens_nonnegative');
    expect(v.pass).toBe(false);
    expect(v.offending).toBe(1);
    expect(v.sample[0]).toBe('quality_60_tokens_nonnegative: r1 | -5');
  });

  it('tolerates an empty result set (no header) as a pass', () => {
    expect(evaluateQualityRows([], 'x').pass).toBe(true);
  });
});
