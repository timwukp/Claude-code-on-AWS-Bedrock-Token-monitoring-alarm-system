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
  output?: { outputTokenCount?: number };
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
      if (r.requestId && r.timestamp) out.push(r);
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
  return r.requestMetadata?.project_id ?? 'untagged';
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
  users: Set<string>; // distinct user_id values seen
  requestIds: Set<string>; // idempotency / de-dup
}

/**
 * Fold records into per-(tenant, project, model) aggregates so the By-Project view can read
 * DynamoDB instead of running Athena per request (#7). De-dups by requestId; tracks distinct
 * user_id for a per-project user count. Records without a project tag roll up under "untagged".
 */
export function aggregateByProject(records: InvocationRecord[]): Map<string, ProjectAggregate> {
  const map = new Map<string, ProjectAggregate>();
  for (const r of records) {
    const tenant = tenantOf(r);
    const projectId = projectOf(r);
    const key = `${tenant}|${projectId}|${r.modelId}`;
    let agg = map.get(key);
    if (!agg) {
      agg = {
        tenant, projectId, modelId: r.modelId,
        inputTokens: 0, outputTokens: 0, cacheReadTokens: 0,
        invocations: 0, users: new Set(), requestIds: new Set(),
      };
      map.set(key, agg);
    }
    if (agg.requestIds.has(r.requestId)) continue;
    agg.requestIds.add(r.requestId);
    agg.invocations += 1;
    agg.inputTokens += r.input?.inputTokenCount ?? 0;
    agg.outputTokens += r.output?.outputTokenCount ?? 0;
    agg.cacheReadTokens += r.input?.cacheReadInputTokenCount ?? 0;
    const userId = r.requestMetadata?.user_id;
    if (userId) agg.users.add(userId);
  }
  return map;
}

/**
 * Fold records into per-(tenant, model, hour) aggregates. Keyed map; de-dups by requestId so
 * re-processing the same file is idempotent.
 */
export function aggregate(records: InvocationRecord[]): Map<string, UsageAggregate> {
  const map = new Map<string, UsageAggregate>();
  for (const r of records) {
    const tenant = tenantOf(r);
    const hour = hourBucketOf(r.timestamp);
    const key = `${tenant}|${r.modelId}|${hour}`;
    let agg = map.get(key);
    if (!agg) {
      agg = {
        tenant, modelId: r.modelId, hourBucket: hour,
        inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
        invocations: 0, requestIds: new Set(),
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
  }
  return map;
}
