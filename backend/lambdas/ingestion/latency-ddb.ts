/**
 * How LatencyStats travel in and out of DynamoDB rollup items (#13 phase 1b).
 *
 * Every field is a flat NUMBER attribute so the aggregator's existing `ADD` writers can fold a batch
 * onto an item that may or may not exist yet — `ADD` on a nested map path fails when the map is
 * absent, and lists cannot be ADDed at all. Buckets are `latB<i>` / `ttfbB<i>`; only the buckets a
 * batch actually touched are written, so the expression stays short. The read side rebuilds the
 * arrays with zeros for absent attributes. Pure, so both directions are unit-tested and the
 * backfill script shares them with the live aggregator.
 */
import { LATENCY_BUCKET_COUNT, LatencyStats, emptyLatencyStats } from './parse';

export interface LatencyAddClause {
  /** Fragment to append to an `ADD` list (leading ', ' included), '' when nothing to write. */
  clause: string;
  values: Record<string, number>;
}

/** Build the ADD fragment for a batch's stats. Nothing to write → empty clause, no values. */
export function latencyAddClause(s: LatencyStats): LatencyAddClause {
  if (s.latencyCount <= 0) return { clause: '', values: {} };
  const parts: string[] = ['latencyCount :lc', 'latencySumMs :ls'];
  const values: Record<string, number> = { ':lc': s.latencyCount, ':ls': s.latencySumMs };
  s.latencyBuckets.forEach((n, i) => { if (n > 0) { parts.push(`latB${i} :lb${i}`); values[`:lb${i}`] = n; } });
  if (s.ttfbCount > 0) {
    parts.push('ttfbCount :tc', 'ttfbSumMs :ts');
    values[':tc'] = s.ttfbCount; values[':ts'] = s.ttfbSumMs;
    s.ttfbBuckets.forEach((n, i) => { if (n > 0) { parts.push(`ttfbB${i} :tb${i}`); values[`:tb${i}`] = n; } });
  }
  return { clause: ', ' + parts.join(', '), values };
}

/** Rebuild LatencyStats from a rollup item; absent attributes read as zero. */
export function latencyFromItem(item: Record<string, unknown>): LatencyStats {
  const num = (k: string) => { const v = item[k]; return typeof v === 'number' && Number.isFinite(v) ? v : 0; };
  const s = emptyLatencyStats();
  s.latencyCount = num('latencyCount'); s.latencySumMs = num('latencySumMs');
  s.ttfbCount = num('ttfbCount'); s.ttfbSumMs = num('ttfbSumMs');
  for (let i = 0; i < LATENCY_BUCKET_COUNT; i += 1) { s.latencyBuckets[i] = num(`latB${i}`); s.ttfbBuckets[i] = num(`ttfbB${i}`); }
  return s;
}

/**
 * A latency-ONLY update for the backfill: the same attributes the live writers ADD, without the
 * token counters (those were rolled up long ago). Null when the batch has no samples.
 */
export function latencyOnlyAdd(s: LatencyStats): { expression: string; values: Record<string, number> } | null {
  const c = latencyAddClause(s);
  if (!c.clause) return null;
  return { expression: 'ADD ' + c.clause.slice(2), values: c.values };
}

/**
 * The same, plus `SET k = if_not_exists(k, :v)` for the item's identifying attributes. An ADD onto a
 * key that has no item creates one holding ONLY the counters; readers that key on `projectId`
 * would then lose it. The backfill hit exactly that: latency for pre-profile history keyed to
 * (day, untagged, model), where the token backfill had re-attributed the row to a project and no
 * `untagged` row remained. `if_not_exists` leaves existing items untouched.
 */
export function latencyOnlyAddWithKeys(
  s: LatencyStats,
  keys: Record<string, string>,
): { expression: string; names: Record<string, string>; values: Record<string, unknown> } | null {
  const base = latencyOnlyAdd(s);
  if (!base) return null;
  const names: Record<string, string> = {};
  const values: Record<string, unknown> = { ...base.values };
  const sets = Object.entries(keys).map(([k, v], i) => {
    names[`#k${i}`] = k; values[`:k${i}`] = v;
    return `#k${i} = if_not_exists(#k${i}, :k${i})`;
  });
  return { expression: `SET ${sets.join(', ')} ${base.expression}`, names, values };
}
