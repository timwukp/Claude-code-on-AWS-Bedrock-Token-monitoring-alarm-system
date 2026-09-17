import { S3Client, ListObjectsV2Command, GetObjectCommand } from '@aws-sdk/client-s3';
import { BedrockClient, GetInferenceProfileCommand, ListTagsForResourceCommand } from '@aws-sdk/client-bedrock';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, UpdateCommand, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { gunzipSync } from 'zlib';
import {
  parseLogFile, aggregate, aggregateByProject, aggregateByProjectDay,
  AttributionMaps, InvocationRecord, UsageAggregate, ProjectAggregate, ProjectDayAggregate,
} from './parse';
import { normalizeModelId } from '../api/cost-calc';
import {
  PROFILE_PK, ProfileCacheItem, loadAttributionMaps, listProfiles, putProfile,
} from '../shared/project-registry';

const s3 = new S3Client({});
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const TABLE = process.env.AGGREGATES_TABLE!;
const BUCKET = process.env.RAW_LOG_BUCKET!;
// Logs land under model-logs/AWSLogs/<acct>/BedrockModelInvocationLogs/<region>/YYYY/MM/DD/HH/
const PREFIX = process.env.LOG_PREFIX ?? 'model-logs/AWSLogs/';

/**
 * Scheduled aggregator: read recent Bedrock invocation-log files from S3, fold them into
 * per-(tenant, model, hour) usage, and upsert atomically into DynamoDB so dashboard reads are
 * fast and cheap. Idempotent: DynamoDB items track which requestIds were counted, and a
 * watermark skips already-processed objects (Reliability pillar).
 */
export const handler = async (): Promise<{ filesProcessed: number; aggregatesWritten: number }> => {
  const watermark = await getWatermark();
  const objects = await listNewLogObjects(watermark);

  // Project attribution maps (#13): AIP-ARN → project/model + identity hints. Loaded once per
  // run; extended below when unseen application-inference-profile ARNs appear in the logs.
  const maps = await loadAttributionMapsSafe();

  const allAggregates = new Map<string, UsageAggregate>();
  const allProjects = new Map<string, ProjectAggregate>();
  const allProjectDays = new Map<string, ProjectDayAggregate>();

  let maxKeyTime = watermark;
  const batches: InvocationRecord[][] = [];
  for (const obj of objects) {
    // Skip the split-out large bodies and the permission-check markers; only main records carry tokens.
    if (obj.key.includes('/data/') || obj.key.includes('permission-check')) continue;
    const body = await getDecompressed(obj.key);
    batches.push(parseLogFile(body));
    if (obj.lastModified > maxKeyTime) maxKeyTime = obj.lastModified;
  }

  // Resolve application-inference-profile ARNs we haven't cached yet, BEFORE aggregating,
  // so this run's records are attributed correctly instead of waiting for the next run.
  if (maps) await resolveUnseenProfiles(batches, maps);

  for (const records of batches) {
    mergeInto(allAggregates, aggregate(records, maps ?? undefined));
    mergeProjects(allProjects, aggregateByProject(records, maps ?? undefined));
    mergeProjectDays(allProjectDays, aggregateByProjectDay(records, maps ?? undefined));
  }

  let written = 0;
  for (const agg of allAggregates.values()) {
    await upsertUsage(agg);
    await upsertModelRollup(agg);
    written++;
  }
  for (const p of allProjects.values()) {
    await upsertProjectRollup(p);
    written++;
  }
  for (const d of allProjectDays.values()) {
    await upsertProjectDayRollup(d);
    written++;
  }

  if (objects.length > 0) await setWatermark(maxKeyTime);
  console.log(`Processed ${objects.length} objects, wrote ${written} aggregates.`);
  return { filesProcessed: objects.length, aggregatesWritten: written };
};

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
  const known = new Set(maps.profiles.keys());
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
      if (projectId !== 'untagged') {
        maps.profiles.set(arn, { projectId, underlyingModelId: item.underlyingModelId });
        console.log(`aggregator: resolved ${arn} → project=${projectId} model=${item.underlyingModelId}`);
      } else {
        console.warn(`aggregator: profile ${arn} has no project tag — negative-cached 24h`);
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

function mergeInto(target: Map<string, UsageAggregate>, src: Map<string, UsageAggregate>) {
  for (const [k, v] of src) {
    const e = target.get(k);
    if (!e) { target.set(k, v); continue; }
    for (const id of v.requestIds) {
      if (e.requestIds.has(id)) continue;
      e.requestIds.add(id);
    }
    e.inputTokens += v.inputTokens; e.outputTokens += v.outputTokens;
    e.cacheReadTokens += v.cacheReadTokens; e.cacheWriteTokens += v.cacheWriteTokens;
    e.invocations += v.invocations;
  }
}

/** Time-series item: pk=TENANT#<tenant>#USAGE, sk=<hour> (read by GET /v1/usage). */
async function upsertUsage(a: UsageAggregate) {
  await ddb.send(new UpdateCommand({
    TableName: TABLE,
    Key: { pk: `TENANT#${a.tenant}#USAGE`, sk: a.hourBucket },
    UpdateExpression:
      'ADD inputTokens :i, outputTokens :o, cacheReadTokens :cr, cacheWriteTokens :cw, invocations :n',
    ExpressionAttributeValues: {
      ':i': a.inputTokens, ':o': a.outputTokens, ':cr': a.cacheReadTokens,
      ':cw': a.cacheWriteTokens, ':n': a.invocations,
    },
  }));
}

/** Per-model rollup: pk=TENANT#<tenant>#MODEL, sk=<modelId> (read by GET /v1/costs). */
async function upsertModelRollup(a: UsageAggregate) {
  await ddb.send(new UpdateCommand({
    TableName: TABLE,
    Key: { pk: `TENANT#${a.tenant}#MODEL`, sk: a.modelId },
    UpdateExpression: 'SET modelId = :m ADD inputTokens :i, outputTokens :o, cacheReadTokens :cr, invocations :n',
    ExpressionAttributeValues: {
      ':m': a.modelId, ':i': a.inputTokens, ':o': a.outputTokens, ':cr': a.cacheReadTokens, ':n': a.invocations,
    },
  }));
}

/** Merge per-project aggregates across files; de-dup by requestId, union the user sets. */
function mergeProjects(target: Map<string, ProjectAggregate>, src: Map<string, ProjectAggregate>) {
  for (const [k, v] of src) {
    const e = target.get(k);
    if (!e) { target.set(k, v); continue; }
    for (const id of v.requestIds) {
      if (e.requestIds.has(id)) continue;
      e.requestIds.add(id);
    }
    for (const u of v.users) e.users.add(u);
    e.inputTokens += v.inputTokens; e.outputTokens += v.outputTokens;
    e.cacheReadTokens += v.cacheReadTokens; e.invocations += v.invocations;
  }
}

/**
 * Per-project rollup: pk=TENANT#<tenant>#PROJECT, sk=<projectId>#<modelId> (read fast by
 * GET /v1/projects without an Athena scan). `users` is stored as a string set of distinct ids.
 */
async function upsertProjectRollup(p: ProjectAggregate) {
  const users = [...p.users];
  await ddb.send(new UpdateCommand({
    TableName: TABLE,
    Key: { pk: `TENANT#${p.tenant}#PROJECT`, sk: `${p.projectId}#${p.modelId}` },
    UpdateExpression:
      'SET projectId = :p, modelId = :m ADD inputTokens :i, outputTokens :o, cacheReadTokens :cr, invocations :n'
      + (users.length ? ', userSet :u' : ''),
    ExpressionAttributeValues: {
      ':p': p.projectId, ':m': p.modelId,
      ':i': p.inputTokens, ':o': p.outputTokens, ':cr': p.cacheReadTokens, ':n': p.invocations,
      ...(users.length ? { ':u': new Set(users) } : {}),
    },
  }));
}

/** Merge per-(tenant,day,project,model) aggregates across files; de-dup by requestId. */
function mergeProjectDays(target: Map<string, ProjectDayAggregate>, src: Map<string, ProjectDayAggregate>) {
  for (const [k, v] of src) {
    const e = target.get(k);
    if (!e) { target.set(k, v); continue; }
    for (const id of v.requestIds) {
      if (e.requestIds.has(id)) continue;
      e.requestIds.add(id);
    }
    e.inputTokens += v.inputTokens; e.outputTokens += v.outputTokens;
    e.cacheReadTokens += v.cacheReadTokens; e.invocations += v.invocations;
  }
}

/**
 * Daily project rollup (#13): pk=TENANT#<tenant>#PROJDAY, sk=<day>#<projectId>#<modelId> —
 * lets the DORA page query project cost for the same 7/30/90-day windows it uses for metrics.
 */
async function upsertProjectDayRollup(d: ProjectDayAggregate) {
  await ddb.send(new UpdateCommand({
    TableName: TABLE,
    Key: { pk: `TENANT#${d.tenant}#PROJDAY`, sk: `${d.day}#${d.projectId}#${d.modelId}` },
    UpdateExpression:
      'SET #day = :d, projectId = :p, modelId = :m ADD inputTokens :i, outputTokens :o, cacheReadTokens :cr, invocations :n',
    ExpressionAttributeNames: { '#day': 'day' },
    ExpressionAttributeValues: {
      ':d': d.day, ':p': d.projectId, ':m': d.modelId,
      ':i': d.inputTokens, ':o': d.outputTokens, ':cr': d.cacheReadTokens, ':n': d.invocations,
    },
  }));
}

async function getWatermark(): Promise<number> {
  const res = await ddb.send(new GetCommand({ TableName: TABLE, Key: { pk: 'SYSTEM#WATERMARK', sk: 'aggregator' } }));
  return (res.Item?.lastModified as number) ?? 0;
}

async function setWatermark(ts: number): Promise<void> {
  await ddb.send(new PutCommand({ TableName: TABLE, Item: { pk: 'SYSTEM#WATERMARK', sk: 'aggregator', lastModified: ts } }));
}
