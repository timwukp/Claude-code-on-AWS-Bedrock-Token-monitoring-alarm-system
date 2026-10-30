import { USAGE_MAX_DAYS, usageRange } from './usage';

describe('usageRange — /v1/usage window validation (feature-49)', () => {
  it('defaults to the last 7 days when both bounds are absent', () => {
    const r = usageRange(undefined, undefined);
    if ('error' in r) throw new Error(r.error);
    expect(Date.parse(r.to) - Date.parse(r.from)).toBeGreaterThan(6.9 * 86_400_000);
  });
  it('accepts ISO bounds and normalises them', () => {
    expect(usageRange('2026-10-01', '2026-10-05T12:00:00Z')).toEqual({ from: '2026-10-01T00:00:00.000Z', to: '2026-10-05T12:00:00.000Z' });
  });
  it('rejects garbage, reversed bounds and over-long windows', () => {
    expect(usageRange('0', 'z')).toEqual({ error: expect.stringContaining('ISO-8601') });
    expect(usageRange('2026-10-05', '2026-10-01')).toEqual({ error: 'from must not be after to' });
    expect(usageRange('2026-01-01', '2026-10-01')).toEqual({ error: `window must be at most ${USAGE_MAX_DAYS} days` });
    expect(usageRange('Mon Oct 05 2026', undefined)).toEqual({ error: expect.stringContaining('ISO-8601') }); // Date.parse accepts it; we do not
  });
});
