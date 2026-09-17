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
        invocations: 0, requestIds: new Set(),
      };
      map.set(key, agg);
    }
    if (agg.requestIds.has(r.requestId)) continue;
    agg.requestIds.add(r.requestId);
    agg.invocations += 1;
    agg.inputTokens += r.input?.inputTokenCount ?? 0;
    agg.outputTokens += r.output?.outputTokenCount ?? 0;
    agg.cacheReadTokens += r.input?.cacheReadInputTokenCount ?? 0;
  }
  return map;
}
