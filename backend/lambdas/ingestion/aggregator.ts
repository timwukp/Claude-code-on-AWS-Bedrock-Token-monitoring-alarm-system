import { S3Client, ListObjectsV2Command, GetObjectCommand } from '@aws-sdk/client-s3';
import { BedrockClient, GetInferenceProfileCommand, ListTagsForResourceCommand } from '@aws-sdk/client-bedrock';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, UpdateCommand, GetCommand, PutCommand, BatchGetCommand, BatchGetCommandInput, BatchGetCommandOutput } from '@aws-sdk/lib-dynamodb';
import { gunzipSync } from 'zlib';
import {
  parseLogFile, aggregate, aggregateByProject, aggregateByProjectDay, detectRunaways,
  AttributionMaps, CacheWriteCounters, InvocationRecord, RunawayHit, UsageAggregate, ProjectAggregate,
  ProjectDayAggregate, mergeCacheWrite, mergeLatency,
} from './parse';
import { latencyAddClause } from './latency-ddb';
import { computeModelCost, normalizeModelId } from '../api/cost-calc';
import {
  PROFILE_PK, ProfileCacheItem, loadAttributionMaps, listProfiles, putProfile,
} from '../shared/project-registry';
import { anomalyPk, anomalySk } from '../shared/anomaly-key';

const s3 = new S3Client({});
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const TABLE = process.env.AGGREGATES_TABLE!;
const BUCKET = process.env.RAW_LOG_BUCKET!;
// Logs land under model-logs/AWSLogs/<acct>/BedrockModelInvocationLogs/<region>/YYYY/MM/DD/HH/
const PREFIX = process.env.LOG_PREFIX ?? 'model-logs/AWSLogs/';

/**
 * Scheduled aggregator: read recent Bedrock invocation-log files from S3, fold them into
 * per-(tenant, model, hour) usage, and upsert atomically into DynamoDB so dashboard reads are
 * fast and cheap.
 *
 * Idempotency (feature-47): the `ADD` upserts are not reversible, so a run that throws after some of
 * them and before its watermark moved used to re-add the same objects on the next run — forever, if
 * the cause was persistent (the 400 KB `SYSTEM#TENANTS` item was ~85% full when this was written).
 * Now every object is processed on its own: aggregate → upsert → `SYSTEM#PROCESSED/<key>` marker →
 * watermark. The marker (TTL 30 days) is what makes a retry skip the object; the watermark only
 * narrows the S3 listing and is re-read with a one-minute overlap so same-second objects are not lost.
 */
export const handler = async (): Promise<{ filesProcessed: number; aggregatesWritten: number; skipped: number }> => {
  const { lastModified: watermark, markersSince } = await getWatermarkState();
  // The overlap is only safe once processed-markers exist to de-duplicate it. On the first run after the
  // switch (no marker ever written) the old strict `> watermark` listing is kept, so objects the previous
  // code already counted are not re-added once.
  const listed = await listNewLogObjects(markersSince ? watermark - LIST_OVERLAP_MS : watermark);
  const processed = await processedKeys(listed.map((o) => o.key));
  const objects = planObjects(listed, processed);

  // Project attribution maps (#13): AIP-ARN → project/model + identity hints. Loaded once per
  // run; extended below when unseen application-inference-profile ARNs appear in the logs.
  const maps = await loadAttributionMapsSafe();
  const tenantsSeen = new Set<string>();

  let written = 0;
  let maxKeyTime = watermark;
  const markersFrom = markersSince ?? new Date().toISOString(); // persisted once the first marker is written
  for (const obj of objects) {
    try {
      written += await processObject(obj, maps, tenantsSeen);
    } catch (err) {
      // A failure inside an object (throttle, marshaller error, timeout-adjacent) leaves its earlier upserts
      // in place; the retry re-adds them. Bound that: after MAX_OBJECT_ATTEMPTS the object is marked as
      // failed-and-skipped so one poisoned file cannot pin the watermark and inflate counters forever.
      const attempts = await recordFailure(obj.key, (err as Error).message);
      if (attempts >= MAX_OBJECT_ATTEMPTS) {
        console.error(`aggregator: giving up on ${obj.key} after ${attempts} attempt(s): ${(err as Error).message}`);
        await markProcessed(obj.key, obj.lastModified, { failed: true, attempts });
      } else {
        console.warn(`aggregator: ${obj.key} failed (attempt ${attempts}/${MAX_OBJECT_ATTEMPTS}); stopping this run so it is retried next run: ${(err as Error).message}`);
        break; // do not advance past it
      }
    }
    if (obj.lastModified > maxKeyTime) maxKeyTime = obj.lastModified;
    await setWatermark(maxKeyTime, markersFrom);
  }

  // `lastRunAt` moves on EVERY run, including one that found nothing new, so readers can tell "the
  // aggregator is healthy and the logs are quiet" from "the aggregator has stopped" (feature-36).
  await setWatermark(maxKeyTime, markersSince || objects.length ? markersFrom : undefined);
  const skipped = listed.length - objects.length;
  console.log(`Processed ${objects.length} objects (${skipped} skipped: bodies, markers or already processed), wrote ${written} aggregates.`);
  return { filesProcessed: objects.length, aggregatesWritten: written, skipped };
};

/** How many runs may fail on the same object before it is skipped for good (each failure can re-add its earlier rollups once). */
export const MAX_OBJECT_ATTEMPTS = 3;

/** Aggregate and persist ONE log object; returns the number of rollups written. Throws on any persistence error. */
async function processObject(obj: { key: string; lastModified: number }, maps: AttributionMaps | null, tenantsSeen: Set<string>): Promise<number> {
  let written = 0;
  const records = parseLogFile(await getDecompressed(obj.key));
  // Resolve application-inference-profile ARNs we haven't cached yet, BEFORE aggregating,
  // so this object's records are attributed correctly instead of waiting for the next run.
  if (maps) await resolveUnseenProfiles([records], maps);

  const aggregates = aggregate(records, maps ?? undefined);
  const projects = aggregateByProject(records, maps ?? undefined);
  const projectDays = aggregateByProjectDay(records, maps ?? undefined);
  // Runaway-spend guard (#14): flag single requests above the absolute threshold.
  await writeRunawayAnomalies(detectRunaways(records, maps ?? undefined, RUNAWAY_THRESHOLD_USD, priceRecordUsd));

  for (const agg of aggregates.values()) { await upsertUsage(agg); await upsertModelRollup(agg); written++; }
  for (const p of projects.values()) { await upsertProjectRollup(p); written++; }
  for (const d of projectDays.values()) { await upsertProjectDayRollup(d); written++; }

  // Tenant index (feature-40): one item per tenant (feature-47 — the single-item form hit DynamoDB's
  // 400 KB ceiling at ~3,000 session ARNs), written once per run per tenant.
  await recordTenants([...aggregates.values()].map((a) => a.tenant).filter((t) => !tenantsSeen.has(t)));
  for (const a of aggregates.values()) tenantsSeen.add(a.tenant);

  await markProcessed(obj.key, obj.lastModified);
  return written;
}

/** Re-list this far behind the watermark: objects written in the same second as the last one processed. */
export const LIST_OVERLAP_MS = 60_000;
const PROCESSED_PK = 'SYSTEM#PROCESSED';
const PROCESSED_TTL_DAYS = 30;

/**
 * The objects a run must process, oldest first: main log records only (not the split-out large
 * bodies or the permission-check markers) and not already marked processed. Oldest-first matters
 * because the watermark advances per object — a newer object processed before an older one would
 * move the listing past the older one.
 */
export function planObjects<T extends { key: string; lastModified: number }>(listed: T[], processed: Set<string>): T[] {
  return listed
    .filter((o) => !o.key.includes('/data/') && !o.key.includes('permission-check') && !processed.has(o.key))
    .sort((a, b) => a.lastModified - b.lastModified || a.key.localeCompare(b.key));
}

async function processedKeys(keys: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  for (let i = 0; i < keys.length; i += 100) {
    let req: BatchGetCommandInput['RequestItems'] = { [TABLE]: { Keys: keys.slice(i, i + 100).map((k) => ({ pk: PROCESSED_PK, sk: k })) } };
    while (req && Object.keys(req).length) {
      const res: BatchGetCommandOutput = await ddb.send(new BatchGetCommand({ RequestItems: req }));
      for (const it of (res.Responses?.[TABLE] ?? []) as Record<string, unknown>[]) out.add(String(it.sk));
      req = res.UnprocessedKeys && Object.keys(res.UnprocessedKeys).length ? res.UnprocessedKeys : undefined;
    }
  }
  return out;
}

async function markProcessed(key: string, lastModified: number, extra: Record<string, unknown> = {}): Promise<void> {
  await ddb.send(new PutCommand({
    TableName: TABLE,
    Item: { pk: PROCESSED_PK, sk: key, lastModified, processedAt: new Date().toISOString(), expiresAt: Math.floor(Date.now() / 1000) + PROCESSED_TTL_DAYS * 86_400, ...extra },
  }));
}

const FAILED_PK = 'SYSTEM#FAILED';

/** Count a failed attempt on an object (kept 30 days); returns the attempt number. */
async function recordFailure(key: string, message: string): Promise<number> {
  const res = await ddb.send(new UpdateCommand({
    TableName: TABLE, Key: { pk: FAILED_PK, sk: key },
    UpdateExpression: 'SET lastError = :e, lastAt = :t, expiresAt = :x ADD attempts :one',
    ExpressionAttributeValues: { ':e': message.slice(0, 500), ':t': new Date().toISOString(), ':x': Math.floor(Date.now() / 1000) + PROCESSED_TTL_DAYS * 86_400, ':one': 1 },
    ReturnValues: 'ALL_NEW',
  }));
  return Number(res.Attributes?.attempts ?? 1);
}

const bedrock = new BedrockClient({});
const AIP_ARN_RE = /^arn:[^:]+:bedrock:[^:]*:[^:]*:application-inference-profile\//;
const RETRY_NEGATIVE_MS = 24 * 3_600_000;

/** Registry may be undeployed (no TENANTS_TABLE): degrade to legacy attribution, don't fail. */
async function loadAttributionMapsSafe(): Promise<AttributionMaps | null> {
  if (!process.env.TENANTS_TABLE) return null;
  try {
    return await loadAttributionMaps();
  } catch (err) {
    console.warn('aggregator: could not load attribution maps — continuing untagged', (err as Error).message);
    return null;
  }
}

/**
 * Resolve AIP ARNs seen in this batch but absent from the map: the profile's `project` tag names
 * the owning project; its wrapped model gives the real model id for pricing. Failures are
 * negative-cached for 24h so a later tag fix heals without hammering the control plane.
 */
async function resolveUnseenProfiles(batches: InvocationRecord[][], maps: AttributionMaps): Promise<void> {
  // "Known" means tagged. An untagged profile may already be in the map for its model, but its tag
  // is still worth re-checking (the negative cache below rate-limits that to once a day).
  const known = new Set([...maps.profiles].filter(([, v]) => v.projectId !== 'untagged').map(([k]) => k));
  let negatives: Map<string, ProfileCacheItem> | null = null;
  const unseen = new Set<string>();
  for (const records of batches) {
    for (const r of records) {
      if (AIP_ARN_RE.test(r.modelId) && !known.has(r.modelId)) unseen.add(r.modelId);
    }
  }
  for (const arn of unseen) {
    // Respect an unexpired negative cache entry (loaded lazily — usually there are none).
    if (negatives === null) {
      negatives = new Map();
      try {
        for (const p of await listProfiles()) if (p.projectId === 'untagged') negatives.set(p.arn, p);
      } catch { /* table readable moments ago; treat as empty */ }
    }
    const neg = negatives.get(arn);
    if (neg?.retryAfterMs && Date.now() < neg.retryAfterMs) continue;
    try {
      const [prof, tags] = await Promise.all([
        bedrock.send(new GetInferenceProfileCommand({ inferenceProfileIdentifier: arn })),
        bedrock.send(new ListTagsForResourceCommand({ resourceARN: arn })),
      ]);
      const projectId = tags.tags?.find((t) => t.key === 'tums-project')?.value ?? 'untagged';
      const wrapped = prof.models?.[0]?.modelArn ?? '';
      const item: ProfileCacheItem = {
        pk: PROFILE_PK, sk: arn, type: 'profile', arn,
        projectId,
        underlyingModelId: normalizeModelId(wrapped) || arn,
        profileName: prof.inferenceProfileName,
        source: 'runtime-resolve',
        resolvedAt: new Date().toISOString(),
        ...(projectId === 'untagged' ? { retryAfterMs: Date.now() + RETRY_NEGATIVE_MS } : {}),
      };
      await putProfile(item);
      // The model is usable for pricing whether or not the profile is tagged (feature-36).
      if (wrapped) maps.profiles.set(arn, { projectId, underlyingModelId: item.underlyingModelId });
      if (projectId !== 'untagged') {
        console.log(`aggregator: resolved ${arn} → project=${projectId} model=${item.underlyingModelId}`);
      } else {
        console.warn(`aggregator: profile ${arn} has no project tag (model ${item.underlyingModelId}) — tag re-checked in 24h`);
      }
    } catch (err) {
      console.warn('aggregator: could not resolve profile', arn, (err as Error).message);
      await putProfile({
        pk: PROFILE_PK, sk: arn, type: 'profile', arn,
        projectId: 'untagged', underlyingModelId: normalizeModelId(arn),
        source: 'runtime-resolve', resolvedAt: new Date().toISOString(),
        retryAfterMs: Date.now() + RETRY_NEGATIVE_MS,
      }).catch(() => { /* best effort */ });
    }
  }
}

async function listNewLogObjects(since: number): Promise<{ key: string; lastModified: number }[]> {
  const found: { key: string; lastModified: number }[] = [];
  let token: string | undefined;
  do {
    const res = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: PREFIX, ContinuationToken: token }));
    for (const o of res.Contents ?? []) {
      const lm = o.LastModified ? o.LastModified.getTime() : 0;
      if (o.Key && lm > since) found.push({ key: o.Key, lastModified: lm });
    }
    token = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (token);
  return found;
}

async function getDecompressed(key: string): Promise<string> {
  const res = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  const bytes = await res.Body!.transformToByteArray();
  const buf = Buffer.from(bytes);
  // Files are gzip'd; fall back to raw if a future config disables compression.
  try {
    return gunzipSync(buf).toString('utf8');
  } catch {
    return buf.toString('utf8');
  }
}


/**
 * The cache-write counters every rollup ADDs (feature-36). Before this, only the USAGE item stored
 * `cacheWriteTokens` and nothing stored the TTL split, so the MODEL/PROJECT/PROJDAY readers could not
 * price the bill's largest line; `scripts/backfill-cache-write.ts` adds history onto those items.
 */
const CW_CLAUSE = ', cacheWriteTokens :cw, cacheWrite5mTokens :cw5, cacheWrite1hTokens :cw1h';
function cacheWriteValues(c: CacheWriteCounters): Record<string, number> {
  return { ':cw': c.cacheWriteTokens, ':cw5': c.cacheWrite5mTokens, ':cw1h': c.cacheWrite1hTokens };
}

/** Time-series item: pk=TENANT#<tenant>#USAGE, sk=<hour> (read by GET /v1/usage). */
async function upsertUsage(a: UsageAggregate) {
  const lat = latencyAddClause(a.latency);
  await ddb.send(new UpdateCommand({
    TableName: TABLE,
    Key: { pk: `TENANT#${a.tenant}#USAGE`, sk: a.hourBucket },
    UpdateExpression:
      'ADD inputTokens :i, outputTokens :o, cacheReadTokens :cr, invocations :n' + CW_CLAUSE + lat.clause,
    ExpressionAttributeValues: {
      ':i': a.inputTokens, ':o': a.outputTokens, ':cr': a.cacheReadTokens, ':n': a.invocations,
      ...cacheWriteValues(a), ...lat.values,
    },
  }));
}

/** Per-model rollup: pk=TENANT#<tenant>#MODEL, sk=<modelId> (read by GET /v1/costs). */
async function upsertModelRollup(a: UsageAggregate) {
  const lat = latencyAddClause(a.latency);
  await ddb.send(new UpdateCommand({
    TableName: TABLE,
    Key: { pk: `TENANT#${a.tenant}#MODEL`, sk: a.modelId },
    UpdateExpression:
      'SET modelId = :m ADD inputTokens :i, outputTokens :o, cacheReadTokens :cr, invocations :n' + CW_CLAUSE + lat.clause,
    ExpressionAttributeValues: {
      ':m': a.modelId, ':i': a.inputTokens, ':o': a.outputTokens, ':cr': a.cacheReadTokens, ':n': a.invocations,
      ...cacheWriteValues(a), ...lat.values,
    },
  }));
}

/** Merge per-project aggregates across files; de-dup by requestId, union the user sets. */

/**
 * Per-project rollup: pk=TENANT#<tenant>#PROJECT, sk=<projectId>#<modelId> (read fast by
 * GET /v1/projects without an Athena scan). `users` is stored as a string set of distinct ids.
 */
/**
 * `userSet` is a DynamoDB string set that grows with every distinct `requestMetadata.user_id` a caller
 * sends; the item's 400 KB ceiling is ~10k short ids, after which every upsert for that (tenant,
 * project, model) fails. Past this many we stop adding and flag the row; the page shows "500+".
 */
export const USER_SET_CAP = 500;
export function usersToAdd(incoming: Iterable<string>, have: ReadonlySet<string> | number, cap = USER_SET_CAP): { add: string[]; overflow: boolean } {
  const present = typeof have === 'number' ? null : have;
  const currentSize = typeof have === 'number' ? have : have.size;
  const add = [...new Set(incoming)].filter((u) => !present?.has(u)); // ids already in the set need no room
  if (add.length === 0) return { add: [], overflow: false };
  if (currentSize >= cap) return { add: [], overflow: true };
  const room = cap - currentSize;
  return add.length > room ? { add: add.slice(0, room), overflow: true } : { add, overflow: false };
}

async function upsertProjectRollup(p: ProjectAggregate) {
  const lat = latencyAddClause(p.latency);
  let users = { add: [] as string[], overflow: false };
  if (p.users.size) {
    const cur = await ddb.send(new GetCommand({ TableName: TABLE, Key: { pk: `TENANT#${p.tenant}#PROJECT`, sk: `${p.projectId}#${p.modelId}` }, ProjectionExpression: 'userSet, userSetOverflow' }));
    const have = cur.Item?.userSet as Set<string> | undefined;
    users = usersToAdd(p.users, have ?? new Set<string>());
  }
  await ddb.send(new UpdateCommand({
    TableName: TABLE,
    Key: { pk: `TENANT#${p.tenant}#PROJECT`, sk: `${p.projectId}#${p.modelId}` },
    UpdateExpression:
      'SET projectId = :p, modelId = :m' + (users.overflow ? ', userSetOverflow = :ov' : '')
      + ' ADD inputTokens :i, outputTokens :o, cacheReadTokens :cr, invocations :n'
      + CW_CLAUSE + lat.clause + (users.add.length ? ', userSet :u' : ''),
    ExpressionAttributeValues: {
      ':p': p.projectId, ':m': p.modelId,
      ':i': p.inputTokens, ':o': p.outputTokens, ':cr': p.cacheReadTokens, ':n': p.invocations,
      ...cacheWriteValues(p), ...lat.values, ...(users.add.length ? { ':u': new Set(users.add) } : {}), ...(users.overflow ? { ':ov': true } : {}),
    },
  }));
}

/** Merge per-(tenant,day,project,model) aggregates across files; de-dup by requestId. */

/**
 * Daily project rollup (#13): pk=TENANT#<tenant>#PROJDAY, sk=<day>#<projectId>#<modelId> —
 * lets the DORA page query project cost for the same 7/30/90-day windows it uses for metrics.
 */
async function upsertProjectDayRollup(d: ProjectDayAggregate) {
  const lat = latencyAddClause(d.latency);
  await ddb.send(new UpdateCommand({
    TableName: TABLE,
    Key: { pk: `TENANT#${d.tenant}#PROJDAY`, sk: `${d.day}#${d.projectId}#${d.modelId}` },
    UpdateExpression:
      'SET #day = :d, projectId = :p, modelId = :m ADD inputTokens :i, outputTokens :o, cacheReadTokens :cr, invocations :n'
      + CW_CLAUSE + lat.clause,
    ExpressionAttributeNames: { '#day': 'day' },
    ExpressionAttributeValues: {
      ':d': d.day, ':p': d.projectId, ':m': d.modelId,
      ':i': d.inputTokens, ':o': d.outputTokens, ':cr': d.cacheReadTokens, ':n': d.invocations,
      ...cacheWriteValues(d), ...lat.values,
    },
  }));
}

const RUNAWAY_THRESHOLD_USD = Number(process.env.RUNAWAY_REQUEST_USD ?? '50') || 0;
const ANOMALIES_TABLE = process.env.ANOMALIES_TABLE;

function priceRecordUsd(
  modelId: string, input: number, output: number, cacheRead: number, cacheWrite: CacheWriteCounters,
): number {
  return computeModelCost({
    modelId: normalizeModelId(modelId), inputTokens: input, outputTokens: output, cacheReadTokens: cacheRead,
    ...cacheWrite,
  }).estimatedUsd;
}

/**
 * Surface runaway requests on the existing Anomalies feed (#14). Keys come from
 * shared/anomaly-key, which is now the single definition for both writers and the reader — the
 * mismatch this comment used to document (anomaly-response wrote a partition api/anomalies.ts never
 * queried) is fixed there rather than worked around here. The requestId discriminator keeps the sort
 * key deterministic, so a re-processed batch re-puts the same item instead of duplicating the alert.
 */
async function writeRunawayAnomalies(hits: RunawayHit[]): Promise<void> {
  if (!ANOMALIES_TABLE || hits.length === 0) return;
  for (const h of hits) {
    try {
      await ddb.send(new PutCommand({
        TableName: ANOMALIES_TABLE,
        Item: {
          pk: anomalyPk(h.tenant),
          sk: anomalySk(h.timestamp, 'ai-spend-runaway', h.requestId),
          severity: 'WARNING',
          type: 'ai-spend-runaway',
          message: `Single request ${h.requestId} cost ~$${h.estimatedUsd.toFixed(2)} (model ${h.modelId}, project ${h.projectId}) — exceeds the $${RUNAWAY_THRESHOLD_USD} per-request threshold. Justified long task or runaway loop? Review the session.`,
          detectedAt: h.timestamp,
          projectId: h.projectId,
          estimatedUsd: h.estimatedUsd,
        },
      }));
    } catch (err) {
      console.warn('aggregator: could not write runaway anomaly', h.requestId, (err as Error).message);
    }
  }
  console.log(`aggregator: flagged ${hits.length} runaway request(s) above $${RUNAWAY_THRESHOLD_USD}`);
}

export const TENANT_INDEX_PK = 'SYSTEM#TENANT';

/** One item per tenant (`SYSTEM#TENANT / <tenant>`); PutItem is idempotent, so re-recording is harmless. */
async function recordTenants(tenants: string[]): Promise<void> {
  for (const t of new Set(tenants)) {
    await ddb.send(new PutCommand({ TableName: TABLE, Item: { pk: TENANT_INDEX_PK, sk: t, tenant: t, lastSeenAt: new Date().toISOString() } }));
  }
}

/** Watermark plus `markersSince`: when processed-markers started being written (absent = never — first run after the switch). */
async function getWatermarkState(): Promise<{ lastModified: number; markersSince?: string }> {
  const res = await ddb.send(new GetCommand({ TableName: TABLE, Key: { pk: 'SYSTEM#WATERMARK', sk: 'aggregator' } }));
  return { lastModified: Number(res.Item?.lastModified ?? 0), markersSince: typeof res.Item?.markersSince === 'string' ? res.Item.markersSince : undefined };
}

async function setWatermark(ts: number, markersSince?: string): Promise<void> {
  await ddb.send(new PutCommand({
    TableName: TABLE,
    Item: { pk: 'SYSTEM#WATERMARK', sk: 'aggregator', lastModified: ts, lastRunAt: new Date().toISOString(), ...(markersSince ? { markersSince } : {}) },
  }));
}
