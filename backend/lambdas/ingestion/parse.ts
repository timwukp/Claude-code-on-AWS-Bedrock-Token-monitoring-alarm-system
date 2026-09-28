/**
 * Parsing + aggregation logic for Bedrock model-invocation logs.
 *
 * Schema verified against REAL delivered logs (see docs/VERIFICATION.md), which differ from the
 * published userguide example: records carry `identity.arn`, prompt-cache token counts, and an
 * `inputBodyS3Path` when the body exceeds 100 KB. Files are gzip'd, newline-delimited JSON.
 *
 * This module is pure (no AWS calls) so it can be unit-tested without a deployment.
 */

export interface InvocationRecord {
  schemaType?: string;
  timestamp: string;
  accountId?: string;
  region?: string;
  requestId: string;
  operation?: string;
  modelId: string;
  inferenceRegion?: string;
  identity?: { arn?: string };
  requestMetadata?: Record<string, string>;
  input?: {
    inputTokenCount?: number;
    cacheReadInputTokenCount?: number;
    cacheWriteInputTokenCount?: number;
  };
  output?: {
    outputTokenCount?: number;
    /**
     * The model's response body, present only when body logging is on. Streaming responses log
     * an ARRAY of chunks, non-streaming ones an OBJECT. The last chunk (or the object) carries
     * `amazon-bedrock-invocationMetrics` with the service-side latencies. `parseLogFile` reads that
     * one key into `latency` and then DELETES this field: the body is the payload that ran a 4 GB
     * heap out of memory at ~70k records in backfill-projday.ts, and nothing downstream needs it.
     */
    outputBodyJson?: unknown;
  };
  /** Service-side latency for this call, lifted out of the body by `parseLogFile`. */
  latency?: LatencySample | null;
}

/**
 * What Bedrock measured for one call, in milliseconds. `e2eMs` is `invocationLatency` (request in →
 * last byte out, Bedrock service time only). `ttfbMs` is `firstByteLatency` and exists only for
 * streaming calls — so its count is a SUBSET of the e2e count, never a second population.
 */
export interface LatencySample {
  e2eMs: number;
  ttfbMs?: number;
}

/**
 * Pull `amazon-bedrock-invocationMetrics` out of a logged response body. Null when the body was
 * not logged, has no metrics, or the values are not finite non-negative numbers — a null is
 * "unknown", which the aggregates count as nothing rather than as zero latency.
 */
export function latencyOf(r: InvocationRecord): LatencySample | null {
  const body = r.output?.outputBodyJson;
  const last = Array.isArray(body) ? body[body.length - 1] : body;
  if (!last || typeof last !== 'object') return null;
  const m = (last as Record<string, unknown>)['amazon-bedrock-invocationMetrics'];
  if (!m || typeof m !== 'object') return null;
  const e2e = (m as Record<string, unknown>).invocationLatency;
  const ttfb = (m as Record<string, unknown>).firstByteLatency;
  if (typeof e2e !== 'number' || !Number.isFinite(e2e) || e2e < 0) return null;
  const out: LatencySample = { e2eMs: e2e };
  if (typeof ttfb === 'number' && Number.isFinite(ttfb) && ttfb >= 0) out.ttfbMs = ttfb;
  return out;
}

/**
 * Upper edges (ms) of the fixed latency histogram; the last bucket is open-ended. Fixed edges are
 * what lets buckets from many batches be ADDed together in DynamoDB and still yield a percentile
 * (no digest structure to merge). p50/p95 read from these are estimates within a bucket's span —
 * the page must say so — but the fleet-level CloudWatch percentiles remain the exact reference.
 */
export const LATENCY_BUCKET_EDGES_MS: readonly number[] =
  [250, 500, 1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 64_000];
export const LATENCY_BUCKET_COUNT = LATENCY_BUCKET_EDGES_MS.length + 1;

/**
 * Count + sum + fixed buckets for e2e and first-byte, kept as separate populations because only
 * streaming calls carry first-byte. Every field is additive, so a batch's stats can be merged into
 * another batch's — or ADDed onto a DynamoDB item — without loss.
 */
export interface LatencyStats {
  latencyCount: number;
  latencySumMs: number;
  latencyBuckets: number[]; // LATENCY_BUCKET_COUNT entries
  ttfbCount: number;
  ttfbSumMs: number;
  ttfbBuckets: number[];
}

export function emptyLatencyStats(): LatencyStats {
  return {
    latencyCount: 0, latencySumMs: 0, latencyBuckets: new Array(LATENCY_BUCKET_COUNT).fill(0),
    ttfbCount: 0, ttfbSumMs: 0, ttfbBuckets: new Array(LATENCY_BUCKET_COUNT).fill(0),
  };
}

export function bucketIndex(ms: number): number {
  let i = 0;
  while (i < LATENCY_BUCKET_EDGES_MS.length && ms > LATENCY_BUCKET_EDGES_MS[i]) i += 1;
  return i;
}

/** Fold one call's sample into the stats. A null sample folds nothing — unknown is not zero. */
export function foldLatency(stats: LatencyStats, sample: LatencySample | null | undefined): void {
  if (!sample) return;
  stats.latencyCount += 1;
  stats.latencySumMs += sample.e2eMs;
  stats.latencyBuckets[bucketIndex(sample.e2eMs)] += 1;
  if (sample.ttfbMs !== undefined) {
    stats.ttfbCount += 1;
    stats.ttfbSumMs += sample.ttfbMs;
    stats.ttfbBuckets[bucketIndex(sample.ttfbMs)] += 1;
  }
}

export function mergeLatency(target: LatencyStats, src: LatencyStats): void {
  target.latencyCount += src.latencyCount; target.latencySumMs += src.latencySumMs;
  target.ttfbCount += src.ttfbCount; target.ttfbSumMs += src.ttfbSumMs;
  for (let i = 0; i < LATENCY_BUCKET_COUNT; i += 1) {
    target.latencyBuckets[i] += src.latencyBuckets[i] ?? 0;
    target.ttfbBuckets[i] += src.ttfbBuckets[i] ?? 0;
  }
}

/**
 * Estimate the p-th percentile (0..1) from fixed buckets by linear interpolation inside the bucket
 * that contains the rank. Null when there are no samples. The open-ended last bucket has no upper
 * edge, so a rank landing there returns its lower edge — an under-estimate, flagged by the caller
 * as "≥". Callers must present these as estimates.
 */
export function percentileFromBuckets(buckets: readonly number[], p: number): number | null {
  const total = buckets.reduce((s, n) => s + n, 0);
  if (total <= 0) return null;
  const rank = Math.min(total, Math.max(1, Math.ceil(p * total)));
  let seen = 0;
  for (let i = 0; i < buckets.length; i += 1) {
    const n = buckets[i];
    if (n <= 0) continue;
    if (seen + n >= rank) {
      const lo = i === 0 ? 0 : LATENCY_BUCKET_EDGES_MS[i - 1];
      if (i >= LATENCY_BUCKET_EDGES_MS.length) return lo; // open-ended: lower edge
      const hi = LATENCY_BUCKET_EDGES_MS[i];
      const frac = (rank - seen) / n; // position within this bucket, (0, 1]
      return Math.round(lo + (hi - lo) * frac);
    }
    seen += n;
  }
  return null;
}

/** One rolled-up bucket of usage, ready to upsert into DynamoDB. */
export interface UsageAggregate {
  tenant: string; // requestMetadata.tenant if set, else the caller IAM ARN, else "unknown"
  modelId: string;
  hourBucket: string; // ISO hour, e.g. 2026-06-03T06:00:00Z
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  invocations: number;
  latency: LatencyStats; // service-side latency of the calls in this bucket (#13 phase 1b)
  requestIds: Set<string>; // for idempotency / de-dup
}

/** Parse one gzip-decompressed file body (newline-delimited JSON) into records. */
export function parseLogFile(contents: string): InvocationRecord[] {
  const out: InvocationRecord[] = [];
  for (const line of contents.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const r = JSON.parse(t) as InvocationRecord;
      if (!(r.requestId && r.timestamp)) continue;
      // Extract-then-discard: keep the one number we need from the body, never the body itself.
      r.latency = latencyOf(r);
      if (r.output && 'outputBodyJson' in r.output) delete r.output.outputBodyJson;
      out.push(r);
    } catch {
      // Skip malformed lines rather than failing the whole batch (Reliability pillar).
    }
  }
  return out;
}

/** Derive the tenant key: explicit metadata wins, then IAM ARN, then "unknown". */
export function tenantOf(r: InvocationRecord): string {
  return r.requestMetadata?.tenant ?? r.identity?.arn ?? 'unknown';
}

export function hourBucketOf(timestamp: string): string {
  // "2026-06-03T06:54:27Z" -> "2026-06-03T06:00:00Z"
  return timestamp.slice(0, 13) + ':00:00Z';
}

/** Project id from request metadata, or "untagged" when the caller set none (#7). */
export function projectOf(r: InvocationRecord): string {
  return deriveProject(r).projectId;
}

/**
 * Attribution inputs loaded from the project registry (tums-tenants) by the aggregator (#13).
 * `profiles` maps a raw modelId (an application-inference-profile ARN) to the project that owns
 * the profile and the real underlying model id; `identities` maps a lower-cased caller ARN to a
 * project (admin-supplied hints — also how historical untagged traffic is retro-attributed).
 */
export interface AttributionMaps {
  profiles: Map<string, { projectId: string; underlyingModelId: string }>;
  identities: Map<string, string>;
}

/**
 * Attribute one record to a project (#13). Precedence:
 *   1. application inference profile the call came through (authoritative — IAM-enforceable);
 *      also rewrites the model id to the real underlying model so rate cards match;
 *   2. caller-supplied requestMetadata.project_id;
 *   3. admin identity hint for the caller ARN;
 *   4. "untagged".
 */
export function deriveProject(
  r: InvocationRecord,
  maps?: AttributionMaps,
): { projectId: string; effectiveModelId: string } {
  const viaProfile = maps?.profiles.get(r.modelId);
  if (viaProfile) return { projectId: viaProfile.projectId, effectiveModelId: viaProfile.underlyingModelId };
  const viaMetadata = r.requestMetadata?.project_id;
  if (viaMetadata) return { projectId: viaMetadata, effectiveModelId: r.modelId };
  const arn = r.identity?.arn?.toLowerCase();
  const viaIdentity = arn ? maps?.identities.get(arn) : undefined;
  if (viaIdentity) return { projectId: viaIdentity, effectiveModelId: r.modelId };
  return { projectId: 'untagged', effectiveModelId: r.modelId };
}

/** Calendar-day bucket (UTC): "2026-06-03T06:54:27Z" -> "2026-06-03". */
export function dayBucketOf(timestamp: string): string {
  return timestamp.slice(0, 10);
}

/** One per-project rollup, ready to upsert (read fast by GET /v1/projects). */
export interface ProjectAggregate {
  tenant: string;
  projectId: string;
  modelId: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  invocations: number;
  latency: LatencyStats;
  users: Set<string>; // distinct user_id values seen
  requestIds: Set<string>; // idempotency / de-dup
}

/**
 * Fold records into per-(tenant, project, model) aggregates so the By-Project view can read
 * DynamoDB instead of running Athena per request (#7). De-dups by requestId; tracks distinct
 * user_id for a per-project user count. Records without a project tag roll up under "untagged".
 */
export function aggregateByProject(
  records: InvocationRecord[],
  maps?: AttributionMaps,
): Map<string, ProjectAggregate> {
  const map = new Map<string, ProjectAggregate>();
  for (const r of records) {
    const tenant = tenantOf(r);
    const { projectId, effectiveModelId } = deriveProject(r, maps);
    const key = `${tenant}|${projectId}|${effectiveModelId}`;
    let agg = map.get(key);
    if (!agg) {
      agg = {
        tenant, projectId, modelId: effectiveModelId,
        inputTokens: 0, outputTokens: 0, cacheReadTokens: 0,
        invocations: 0, latency: emptyLatencyStats(), users: new Set(), requestIds: new Set(),
      };
      map.set(key, agg);
    }
    if (agg.requestIds.has(r.requestId)) continue;
    agg.requestIds.add(r.requestId);
    agg.invocations += 1;
    agg.inputTokens += r.input?.inputTokenCount ?? 0;
    agg.outputTokens += r.output?.outputTokenCount ?? 0;
    agg.cacheReadTokens += r.input?.cacheReadInputTokenCount ?? 0;
    foldLatency(agg.latency, r.latency ?? latencyOf(r));
    const userId = r.requestMetadata?.user_id;
    if (userId) agg.users.add(userId);
  }
  return map;
}

/**
 * Fold records into per-(tenant, model, hour) aggregates. Keyed map; de-dups by requestId so
 * re-processing the same file is idempotent.
 */
export function aggregate(
  records: InvocationRecord[],
  maps?: AttributionMaps,
): Map<string, UsageAggregate> {
  const map = new Map<string, UsageAggregate>();
  for (const r of records) {
    const tenant = tenantOf(r);
    const hour = hourBucketOf(r.timestamp);
    const modelId = deriveProject(r, maps).effectiveModelId;
    const key = `${tenant}|${modelId}|${hour}`;
    let agg = map.get(key);
    if (!agg) {
      agg = {
        tenant, modelId, hourBucket: hour,
        inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
        invocations: 0, latency: emptyLatencyStats(), requestIds: new Set(),
      };
      map.set(key, agg);
    }
    if (agg.requestIds.has(r.requestId)) continue; // already counted
    agg.requestIds.add(r.requestId);
    agg.invocations += 1;
    agg.inputTokens += r.input?.inputTokenCount ?? 0;
    agg.outputTokens += r.output?.outputTokenCount ?? 0;
    agg.cacheReadTokens += r.input?.cacheReadInputTokenCount ?? 0;
    agg.cacheWriteTokens += r.input?.cacheWriteInputTokenCount ?? 0;
    foldLatency(agg.latency, r.latency ?? latencyOf(r));
  }
  return map;
}

/** One per-(tenant, day, project, model) rollup — powers windowed project cost (#13). */
export interface ProjectDayAggregate {
  tenant: string;
  day: string; // YYYY-MM-DD (UTC)
  projectId: string;
  modelId: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  invocations: number;
  latency: LatencyStats;
  requestIds: Set<string>;
}

/**
 * Fold records into per-(tenant, day, project, model) aggregates so project cost can be
 * queried for the same 7/30/90-day windows the DORA page uses (#13). De-dups by requestId.
 */
export function aggregateByProjectDay(
  records: InvocationRecord[],
  maps?: AttributionMaps,
): Map<string, ProjectDayAggregate> {
  const map = new Map<string, ProjectDayAggregate>();
  for (const r of records) {
    const tenant = tenantOf(r);
    const day = dayBucketOf(r.timestamp);
    const { projectId, effectiveModelId } = deriveProject(r, maps);
    const key = `${tenant}|${day}|${projectId}|${effectiveModelId}`;
    let agg = map.get(key);
    if (!agg) {
      agg = {
        tenant, day, projectId, modelId: effectiveModelId,
        inputTokens: 0, outputTokens: 0, cacheReadTokens: 0,
        invocations: 0, latency: emptyLatencyStats(), requestIds: new Set(),
      };
      map.set(key, agg);
    }
    if (agg.requestIds.has(r.requestId)) continue;
    agg.requestIds.add(r.requestId);
    agg.invocations += 1;
    agg.inputTokens += r.input?.inputTokenCount ?? 0;
    agg.outputTokens += r.output?.outputTokenCount ?? 0;
    agg.cacheReadTokens += r.input?.cacheReadInputTokenCount ?? 0;
    foldLatency(agg.latency, r.latency ?? latencyOf(r));
  }
  return map;
}

/** One suspicious request flagged by the runaway guard (#14). */
export interface RunawayHit {
  requestId: string;
  tenant: string;
  projectId: string;
  modelId: string;
  estimatedUsd: number;
  timestamp: string;
}

/**
 * Runaway-spend guard (#14): flag single requests whose estimated cost exceeds an absolute
 * threshold — real-world incidents show one agent request burning thousands of dollars in
 * hours. Pure: the caller supplies the pricing function so this module stays AWS-free and the
 * rate card stays in cost-calc. A signal for the anomalies feed, never a gate.
 */
export function detectRunaways(
  records: readonly InvocationRecord[],
  maps: AttributionMaps | undefined,
  thresholdUsd: number,
  priceUsd: (modelId: string, input: number, output: number, cacheRead: number) => number,
): RunawayHit[] {
  if (!(thresholdUsd > 0)) return [];
  const hits: RunawayHit[] = [];
  const seen = new Set<string>();
  for (const r of records) {
    if (seen.has(r.requestId)) continue;
    seen.add(r.requestId);
    const { projectId, effectiveModelId } = deriveProject(r, maps);
    const usd = priceUsd(
      effectiveModelId,
      r.input?.inputTokenCount ?? 0,
      r.output?.outputTokenCount ?? 0,
      r.input?.cacheReadInputTokenCount ?? 0,
    );
    if (usd > thresholdUsd) {
      hits.push({
        requestId: r.requestId,
        tenant: tenantOf(r),
        projectId,
        modelId: effectiveModelId,
        estimatedUsd: Math.round(usd * 100) / 100,
        timestamp: r.timestamp,
      });
    }
  }
  return hits;
}
