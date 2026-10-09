/**
 * Cache-write-ONLY updates for `scripts/backfill-cache-write.ts` (feature-36): the same three counters
 * the live writers ADD, without the other token counters (those were rolled up correctly the first
 * time). Pure, so the expression the backfill sends is unit-tested rather than trusted.
 *
 * The USAGE item already carried `cacheWriteTokens` before this feature, so for it only the TTL split
 * is added (`includeTotal: false`); MODEL / PROJECT / PROJDAY never stored any of the three.
 */
import { CacheWriteCounters } from './parse';

export interface CacheWriteOnlyAdd {
  expression: string;
  names: Record<string, string>;
  values: Record<string, unknown>;
}

/**
 * `SET k = if_not_exists(k, :v) … ADD <counters>` — the SET keeps a keyed rollup readable when the ADD
 * lands on a key with no item (the trap the latency backfill hit; see latency-ddb.ts). Null when the
 * batch has nothing to add, so the caller writes nothing and claims no marker for it.
 */
export function cacheWriteOnlyAdd(
  c: CacheWriteCounters,
  opts: { includeTotal: boolean; keys?: Record<string, string>; allowNegative?: boolean },
): CacheWriteOnlyAdd | null {
  const adds: string[] = [];
  const values: Record<string, unknown> = {};
  // A backfill only ever adds; a reconcile (`allowNegative`) also subtracts an established over-count.
  const wanted = (n: number) => (opts.allowNegative ? n !== 0 : n > 0);
  if (opts.includeTotal && wanted(c.cacheWriteTokens)) { adds.push('cacheWriteTokens :cw'); values[':cw'] = c.cacheWriteTokens; }
  if (wanted(c.cacheWrite5mTokens)) { adds.push('cacheWrite5mTokens :cw5'); values[':cw5'] = c.cacheWrite5mTokens; }
  if (wanted(c.cacheWrite1hTokens)) { adds.push('cacheWrite1hTokens :cw1h'); values[':cw1h'] = c.cacheWrite1hTokens; }
  if (adds.length === 0) return null;
  const names: Record<string, string> = {};
  const sets = Object.entries(opts.keys ?? {}).map(([k, v], i) => {
    names[`#k${i}`] = k; values[`:k${i}`] = v;
    return `#k${i} = if_not_exists(#k${i}, :k${i})`;
  });
  const expression = (sets.length ? `SET ${sets.join(', ')} ` : '') + 'ADD ' + adds.join(', ');
  return { expression, names, values };
}
