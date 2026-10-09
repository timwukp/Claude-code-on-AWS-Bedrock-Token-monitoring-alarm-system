import { cacheWriteOnlyAdd } from './cache-write-ddb';

const c = { cacheWriteTokens: 1_000, cacheWrite5mTokens: 700, cacheWrite1hTokens: 100 };

describe('cacheWriteOnlyAdd', () => {
  it('adds all three counters with if_not_exists keys for a keyed rollup', () => {
    const u = cacheWriteOnlyAdd(c, { includeTotal: true, keys: { projectId: 'p1', modelId: 'm1' } })!;
    expect(u.expression).toBe(
      'SET #k0 = if_not_exists(#k0, :k0), #k1 = if_not_exists(#k1, :k1) ADD cacheWriteTokens :cw, cacheWrite5mTokens :cw5, cacheWrite1hTokens :cw1h',
    );
    expect(u.names).toEqual({ '#k0': 'projectId', '#k1': 'modelId' });
    expect(u.values).toEqual({ ':cw': 1_000, ':cw5': 700, ':cw1h': 100, ':k0': 'p1', ':k1': 'm1' });
  });
  it('leaves the total out for the USAGE item, which already stored it', () => {
    const u = cacheWriteOnlyAdd(c, { includeTotal: false })!;
    expect(u.expression).toBe('ADD cacheWrite5mTokens :cw5, cacheWrite1hTokens :cw1h');
    expect(u.values).toEqual({ ':cw5': 700, ':cw1h': 100 });
    expect(u.names).toEqual({});
  });
  it('drops negative counters by default and keeps them only when allowNegative is set (reconcile)', () => {
    const over = { cacheWriteTokens: -15_594, cacheWrite5mTokens: -15_594, cacheWrite1hTokens: 0 };
    expect(cacheWriteOnlyAdd(over, { includeTotal: true })).toBeNull();
    const u = cacheWriteOnlyAdd(over, { includeTotal: true, allowNegative: true })!;
    expect(u.expression).toBe('ADD cacheWriteTokens :cw, cacheWrite5mTokens :cw5');
    expect(u.values).toEqual({ ':cw': -15_594, ':cw5': -15_594 });
  });
  it('omits zero counters and is null when nothing is left to add', () => {
    const u = cacheWriteOnlyAdd({ cacheWriteTokens: 5, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0 }, { includeTotal: true })!;
    expect(u.expression).toBe('ADD cacheWriteTokens :cw');
    expect(cacheWriteOnlyAdd({ cacheWriteTokens: 5, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0 }, { includeTotal: false })).toBeNull();
    expect(cacheWriteOnlyAdd({ cacheWriteTokens: 0, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0 }, { includeTotal: true })).toBeNull();
  });
});
