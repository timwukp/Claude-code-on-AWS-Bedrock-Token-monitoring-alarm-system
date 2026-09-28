/**
 * Per-project latency from the PROJDAY rollups (#13 phase 1b) — pure, so it is unit-tested.
 *
 * The aggregator folds each call's `amazon-bedrock-invocationMetrics` into count + sum + fixed
 * buckets per (day, project, model). Summing those buckets over a window and reading a percentile
 * off the histogram gives a per-project p50/p95 that CloudWatch cannot (its metrics carry no
 * project dimension). Two honesty rules, both carried in the payload:
 *  - `estimated: true` — a bucket percentile is interpolated inside the bucket that holds the rank,
 *    so it is exact only to the bucket's span. The fleet CloudWatch percentiles remain the exact
 *    reference; a project figure should be read against them, not as a replacement.
 *  - `openEnded` — when the rank lands in the last (unbounded) bucket the figure is that bucket's
 *    lower edge, an under-estimate, and the UI must show it as "≥".
 * First-byte is a subset population (streaming calls only); its count is reported beside the e2e
 * count and the two are never added.
 */
import { LatencyStats, LATENCY_BUCKET_EDGES_MS, emptyLatencyStats, mergeLatency, percentileFromBuckets } from '../ingestion/parse';
import { latencyFromItem } from '../ingestion/latency-ddb';

export interface ProjectLatencyFigure {
  samples: number;
  meanMs: number | null;
  p50: number | null;
  p95: number | null;
  estimated: true;
  /** True when p95 (or p50) fell in the unbounded top bucket — the value is a lower bound. */
  openEnded: boolean;
}

export interface ProjectLatencyRow {
  projectId: string;
  name: string;
  e2e: ProjectLatencyFigure;
  ttft: ProjectLatencyFigure;
}

const TOP_EDGE = LATENCY_BUCKET_EDGES_MS[LATENCY_BUCKET_EDGES_MS.length - 1];

function figure(count: number, sumMs: number, buckets: readonly number[]): ProjectLatencyFigure {
  const p50 = percentileFromBuckets(buckets, 0.5);
  const p95 = percentileFromBuckets(buckets, 0.95);
  const topCount = buckets[buckets.length - 1] ?? 0;
  // Open-ended iff the rank for that percentile reached the last bucket — i.e. the returned value
  // is exactly the top edge while that bucket is non-empty.
  const openEnded = topCount > 0 && (p95 === TOP_EDGE || p50 === TOP_EDGE);
  return {
    samples: count,
    meanMs: count > 0 ? Math.round(sumMs / count) : null,
    p50, p95, estimated: true, openEnded,
  };
}

/**
 * Fold PROJDAY items (already filtered to the window by the caller's key range) into one row per
 * project. Items without latency attributes contribute nothing; a project whose items all predate
 * the latency rollout simply has `samples: 0` and is dropped from the result — absence is stated by
 * the caller's coverage note, not faked as zero latency.
 *
 * Pre-profile history: feature-13's one-time HOUR_PROJECT_MAP moved those days' TOKENS from
 * `untagged` to projects. Latency backfilled later attributes by the record's own signals only, so
 * for those days it lands on `untagged` — the treatment cannot be replayed, and only ~2% of it is
 * recoverable unambiguously at day granularity. That is why `untagged` can carry latency on days
 * where it carries no tokens; the two are honest about different things.
 */
export function buildProjectLatencyRows(
  items: Record<string, unknown>[],
  names: Map<string, string>,
): ProjectLatencyRow[] {
  const byProject = new Map<string, LatencyStats>();
  for (const it of items) {
    // Mirror dora.ts: an item with no projectId reads as 'untagged'. Such items exist — a
    // latency-only ADD onto a (day, untagged, model) key the token backfill had re-attributed to a
    // project creates one — and skipping them would hide their samples and under-report coverage.
    const projectId = String(it.projectId ?? 'untagged');
    const s = latencyFromItem(it);
    if (s.latencyCount === 0) continue;
    const acc = byProject.get(projectId) ?? emptyLatencyStats();
    mergeLatency(acc, s);
    byProject.set(projectId, acc);
  }
  return [...byProject].map(([projectId, s]) => ({
    projectId,
    name: names.get(projectId) ?? projectId,
    e2e: figure(s.latencyCount, s.latencySumMs, s.latencyBuckets),
    ttft: figure(s.ttfbCount, s.ttfbSumMs, s.ttfbBuckets),
  })).sort((a, b) => (b.e2e.p95 ?? 0) - (a.e2e.p95 ?? 0) || b.e2e.samples - a.e2e.samples);
}

/** Share of the window's invocations that carry a latency sample — the coverage the UI must state. */
export function latencyCoverage(items: Record<string, unknown>[]): { invocations: number; withLatency: number; pct: number | null } {
  let invocations = 0, withLatency = 0;
  for (const it of items) {
    invocations += typeof it.invocations === 'number' ? it.invocations : 0;
    withLatency += typeof it.latencyCount === 'number' ? it.latencyCount : 0;
  }
  return { invocations, withLatency, pct: invocations > 0 ? Math.round((withLatency / invocations) * 100) : null };
}
