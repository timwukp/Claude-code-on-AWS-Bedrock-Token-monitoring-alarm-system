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
 *   [HOUR_PROJECT_MAP=/path/hour-project-map.json] \
 *   npx ts-node scripts/backfill-projday.ts
 *
 * HOUR_PROJECT_MAP (one-time historical attribution, owner-directed): a JSON object of
 * { "YYYY-MM-DDTHH": "<projectId>" } produced by correlating hourly usage with per-repo
 * commit timestamps. For historical records that carry NO attribution signal of their own
 * (no requestMetadata.project_id; AIP resolution still takes precedence), the record is
 * attributed to the mapped project. In this mode the script ALSO migrates the all-time
 * TENANT#<t>#PROJECT rollups: ADDs the attributed sums per (project, model) and ADDs the
 * equal negative amounts to the 'untagged' rows — atomic, safe alongside the live
 * aggregator, and guarded by a SYSTEM#RETRO marker so it can only ever run once.
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

function loadHourMap(): Record<string, string> | null {
  const p = process.env.HOUR_PROJECT_MAP;
  if (!p) return null;
  const m = JSON.parse(require('fs').readFileSync(p, 'utf8')) as Record<string, string>;
  console.log(`One-time attribution map loaded: ${Object.keys(m).length} hours`);
  return m;
}

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
  // Downloads run CONCURRENTLY: ~100k tiny objects fetched sequentially is a 12-hour job;
  // a worker pool makes it minutes. Pushing into the shared array is safe — the event loop
  // serialises the continuations.
  const records: InvocationRecord[] = [];
  const CONCURRENCY = Number(process.env.BACKFILL_CONCURRENCY ?? '48') || 48;
  let next = 0;
  let done = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const i = next++;
      if (i >= keys.length) return;
      const res = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: keys[i] }));
      const buf = Buffer.from(await res.Body!.transformToByteArray());
      let body: string;
      try { body = gunzipSync(buf).toString('utf8'); } catch { body = buf.toString('utf8'); }
      // SLIM each record immediately: parsed log entries can carry full request/response
      // bodies (inline up to 100 KB) — retaining them OOMed a 4 GB heap at ~70k objects.
      // Keep only what attribution + aggregation read.
      for (const r of parseLogFile(body)) {
        records.push({
          timestamp: r.timestamp,
          requestId: r.requestId,
          modelId: r.modelId,
          identity: r.identity?.arn ? { arn: r.identity.arn } : undefined,
          requestMetadata: r.requestMetadata,
          input: {
            inputTokenCount: r.input?.inputTokenCount,
            cacheReadInputTokenCount: r.input?.cacheReadInputTokenCount,
            cacheWriteInputTokenCount: r.input?.cacheWriteInputTokenCount,
          },
          output: { outputTokenCount: r.output?.outputTokenCount },
        });
      }
      done++;
      if (done % 5000 === 0) console.log(`  parsed ${done}/${keys.length} objects (${records.length} records)`);
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, keys.length) }, () => worker()));
  // One-time historical attribution (owner-directed): inject the mapped project as
  // requestMetadata for records with no attribution signal of their own. deriveProject's
  // precedence is unchanged — an AIP hit still wins over this injection.
  const hourMap = loadHourMap();
  const effective = hourMap
    ? records.map((r) => {
        if (r.requestMetadata?.project_id) return r;
        const mapped = hourMap[r.timestamp.slice(0, 13)];
        return mapped ? { ...r, requestMetadata: { ...(r.requestMetadata ?? {}), project_id: mapped } } : r;
      })
    : records;

  const all = aggregateByProjectDay(effective, maps);
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

  // --- one-time all-time PROJECT rollup migration (map mode only) --------------------------
  if (hourMap) {
    const { aggregateByProject } = await import('../lambdas/ingestion/parse');
    // Only records at/below the watermark: the live aggregator owns everything newer.
    try {
      await ddb.send(new PutCommand({
        TableName: TABLE,
        Item: { pk: 'SYSTEM#RETRO', sk: 'untagged-attribution', at: new Date().toISOString(), hours: Object.keys(hourMap).length },
        ConditionExpression: 'attribute_not_exists(pk)',
      }));
    } catch {
      console.log('PROJECT rollup migration already performed once — skipping (SYSTEM#RETRO marker present).');
      return;
    }
    const byProject = aggregateByProject(effective, maps);
    const byProjectRaw = aggregateByProject(records, maps); // what the rollups currently say
    let moved = 0;
    for (const [key, agg] of byProject) {
      if (agg.projectId === 'untagged') continue;
      const rawKey = key.replace(`|${agg.projectId}|`, '|untagged|');
      const raw = byProjectRaw.get(rawKey);
      // Only migrate the portion that was untagged before the map (metadata-tagged demo
      // traffic is already in its project's row and must not be double-moved).
      const wasTagged = byProjectRaw.get(key);
      const moveIn = agg.inputTokens - (wasTagged?.inputTokens ?? 0);
      const moveOut = agg.outputTokens - (wasTagged?.outputTokens ?? 0);
      const moveCache = agg.cacheReadTokens - (wasTagged?.cacheReadTokens ?? 0);
      const moveInv = agg.invocations - (wasTagged?.invocations ?? 0);
      if (moveInv <= 0 || !raw) continue;
      const add = async (projectId: string, sign: 1 | -1) => ddb.send(new UpdateCommand({
        TableName: TABLE,
        Key: { pk: `TENANT#${agg.tenant}#PROJECT`, sk: `${projectId}#${agg.modelId}` },
        UpdateExpression: 'SET projectId = :p, modelId = :m ADD inputTokens :i, outputTokens :o, cacheReadTokens :cr, invocations :n',
        ExpressionAttributeValues: {
          ':p': projectId, ':m': agg.modelId,
          ':i': sign * moveIn, ':o': sign * moveOut, ':cr': sign * moveCache, ':n': sign * moveInv,
        },
      }));
      await add(agg.projectId, 1);
      await add('untagged', -1);
      moved++;
    }
    console.log(`PROJECT rollup migration: ${moved} (project, model) rows moved out of 'untagged'.`);
  }
}

main().catch((err) => {
  console.error('Backfill failed:', err);
  process.exit(1);
});
