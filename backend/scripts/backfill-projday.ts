/**
 * One-off backfill of the PROJDAY daily project rollups (#13) from historical S3 invocation
 * logs. Safe by construction:
 *   - reads (never writes) the aggregator watermark W0, and only processes objects with
 *     lastModified <= W0 — everything newer is the live aggregator's job;
 *   - complete days (day < day(W0)) are written with SET (PutItem): idempotent re-runs;
 *   - the boundary day day(W0) straddles the watermark, so it is ADDed exactly once, guarded
 *     by a conditional BACKFILL#<day> marker item — re-runs skip it;
 *   - never touches USAGE / MODEL / PROJECT rollups or the watermark.
 * Run AFTER the new aggregator is deployed (so post-W0 objects get PROJDAY via the live path).
 *
 * Usage:
 *   AGGREGATES_TABLE=tums-aggregates-dev TENANTS_TABLE=tums-tenants-dev \
 *   RAW_LOG_BUCKET=<raw-log-bucket> AWS_REGION=us-east-1 \
 *   npx ts-node scripts/backfill-projday.ts
 */
import { S3Client, ListObjectsV2Command, GetObjectCommand } from '@aws-sdk/client-s3';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { gunzipSync } from 'zlib';
import {
  AttributionMaps, InvocationRecord, aggregateByProjectDay, parseLogFile,
} from '../lambdas/ingestion/parse';
import { loadAttributionMaps } from '../lambdas/shared/project-registry';

const s3 = new S3Client({});
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TABLE = process.env.AGGREGATES_TABLE!;
const BUCKET = process.env.RAW_LOG_BUCKET!;
const PREFIX = process.env.LOG_PREFIX ?? 'model-logs/AWSLogs/';

async function main(): Promise<void> {
  const wm = await ddb.send(new GetCommand({ TableName: TABLE, Key: { pk: 'SYSTEM#WATERMARK', sk: 'aggregator' } }));
  const w0 = (wm.Item?.lastModified as number) ?? 0;
  if (w0 === 0) {
    console.log('No aggregator watermark found — the live aggregator has not run yet; nothing to backfill.');
    return;
  }
  const boundaryDay = new Date(w0).toISOString().slice(0, 10);
  console.log(`Watermark W0=${new Date(w0).toISOString()} → complete days < ${boundaryDay}, boundary day = ${boundaryDay}`);

  let maps: AttributionMaps | undefined;
  try {
    maps = await loadAttributionMaps();
    console.log(`Attribution maps: ${maps.profiles.size} profiles, ${maps.identities.size} identity hints`);
  } catch (err) {
    console.warn('Could not load attribution maps — backfilling with metadata-only attribution:', (err as Error).message);
  }

  // List every log object at or before the watermark.
  const keys: string[] = [];
  let token: string | undefined;
  do {
    const res = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: PREFIX, ContinuationToken: token }));
    for (const o of res.Contents ?? []) {
      const lm = o.LastModified ? o.LastModified.getTime() : 0;
      if (!o.Key || lm > w0) continue;
      if (o.Key.includes('/data/') || o.Key.includes('permission-check')) continue;
      keys.push(o.Key);
    }
    token = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (token);
  console.log(`Processing ${keys.length} historical objects…`);

  // Aggregate ONCE over all records so requestId de-dup is global (a per-file aggregate
  // merged afterwards could double-count a request that appears in two files).
  const records: InvocationRecord[] = [];
  let done = 0;
  for (const key of keys) {
    const res = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
    const buf = Buffer.from(await res.Body!.transformToByteArray());
    let body: string;
    try { body = gunzipSync(buf).toString('utf8'); } catch { body = buf.toString('utf8'); }
    records.push(...parseLogFile(body));
    done++;
    if (done % 200 === 0) console.log(`  parsed ${done}/${keys.length} objects (${records.length} records)`);
  }
  const all = aggregateByProjectDay(records, maps);
  console.log(`${records.length} records → ${all.size} (tenant, day, project, model) rollups`);

  let setWrites = 0;
  let boundaryWrites = 0;
  let skippedBoundary = false;

  // Boundary-day guard: one conditional marker per tenant+day; if present, skip the ADDs.
  const boundaryTenants = new Set([...all.values()].filter((v) => v.day === boundaryDay).map((v) => v.tenant));
  const boundaryAllowed = new Set<string>();
  for (const tenant of boundaryTenants) {
    try {
      await ddb.send(new PutCommand({
        TableName: TABLE,
        Item: { pk: `TENANT#${tenant}#PROJDAY`, sk: `BACKFILL#${boundaryDay}`, at: new Date().toISOString() },
        ConditionExpression: 'attribute_not_exists(pk)',
      }));
      boundaryAllowed.add(tenant);
    } catch {
      skippedBoundary = true;
      console.log(`Boundary day ${boundaryDay} for tenant ${tenant} already backfilled — skipping its ADDs.`);
    }
  }

  for (const d of all.values()) {
    if (d.day > boundaryDay) continue; // safety: should not happen given the lastModified filter
    const key = { pk: `TENANT#${d.tenant}#PROJDAY`, sk: `${d.day}#${d.projectId}#${d.modelId}` };
    if (d.day < boundaryDay) {
      await ddb.send(new PutCommand({
        TableName: TABLE,
        Item: {
          ...key, day: d.day, projectId: d.projectId, modelId: d.modelId,
          inputTokens: d.inputTokens, outputTokens: d.outputTokens,
          cacheReadTokens: d.cacheReadTokens, invocations: d.invocations,
        },
      }));
      setWrites++;
    } else if (boundaryAllowed.has(d.tenant)) {
      await ddb.send(new UpdateCommand({
        TableName: TABLE,
        Key: key,
        UpdateExpression:
          'SET #day = :d, projectId = :p, modelId = :m ADD inputTokens :i, outputTokens :o, cacheReadTokens :cr, invocations :n',
        ExpressionAttributeNames: { '#day': 'day' },
        ExpressionAttributeValues: {
          ':d': d.day, ':p': d.projectId, ':m': d.modelId,
          ':i': d.inputTokens, ':o': d.outputTokens, ':cr': d.cacheReadTokens, ':n': d.invocations,
        },
      }));
      boundaryWrites++;
    }
  }
  console.log(`Backfill done: ${setWrites} complete-day items SET, ${boundaryWrites} boundary-day items ADDed${skippedBoundary ? ' (some boundary tenants skipped — already done)' : ''}.`);
}

main().catch((err) => {
  console.error('Backfill failed:', err);
  process.exit(1);
});
