import { S3Client, ListObjectsV2Command, GetObjectCommand } from '@aws-sdk/client-s3';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, UpdateCommand, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { gunzipSync } from 'zlib';
import { parseLogFile, aggregate, aggregateByProject, UsageAggregate, ProjectAggregate } from './parse';

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

  const allAggregates = new Map<string, UsageAggregate>();
  const allProjects = new Map<string, ProjectAggregate>();
  let maxKeyTime = watermark;

  for (const obj of objects) {
    // Skip the split-out large bodies and the permission-check markers; only main records carry tokens.
    if (obj.key.includes('/data/') || obj.key.includes('permission-check')) continue;
    const body = await getDecompressed(obj.key);
    const records = parseLogFile(body);
    mergeInto(allAggregates, aggregate(records));
    mergeProjects(allProjects, aggregateByProject(records));
    if (obj.lastModified > maxKeyTime) maxKeyTime = obj.lastModified;
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

  if (objects.length > 0) await setWatermark(maxKeyTime);
  console.log(`Processed ${objects.length} objects, wrote ${written} aggregates.`);
  return { filesProcessed: objects.length, aggregatesWritten: written };
};

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

async function getWatermark(): Promise<number> {
  const res = await ddb.send(new GetCommand({ TableName: TABLE, Key: { pk: 'SYSTEM#WATERMARK', sk: 'aggregator' } }));
  return (res.Item?.lastModified as number) ?? 0;
}

async function setWatermark(ts: number): Promise<void> {
  await ddb.send(new PutCommand({ TableName: TABLE, Item: { pk: 'SYSTEM#WATERMARK', sk: 'aggregator', lastModified: ts } }));
}
