/**
 * One-off backfill of the latency attributes (#13 phase 1b) onto rollup items that the aggregator
 * wrote BEFORE it learned to extract `amazon-bedrock-invocationMetrics`. Token counters are not
 * touched — they were rolled up correctly the first time; only `latencyCount/SumMs`, `ttfbCount/SumMs`
 * and the `latB<i>` / `ttfbB<i>` buckets are ADDed.
 *
 * Why a cut-off and not the watermark: the aggregator keeps no per-object ledger, only a
 * high-water mark. Every object it processed AFTER the latency-aware build was deployed already
 * carries latency, so re-adding those would double-count. BACKFILL_UNTIL is therefore REQUIRED and
 * must be the deploy time of that build; only objects with lastModified <= BACKFILL_UNTIL are read.
 *
 * Safety, in the style of backfill-projday.ts:
 *  - DRY RUN BY DEFAULT: lists what it would add and exits; `--apply` is required to write.
 *  - Per-object claim marker `SYSTEM#BACKFILL#latency` / `<objectKey>` written with
 *    attribute_not_exists BEFORE the ADDs and flipped to state=done AFTER — for objects that carry
 *    latency; body-less objects add nothing and get no marker. A re-run skips done objects, and
 *    REPORTS claimed-but-not-done ones (a crash mid-object) instead of re-adding them — an
 *    under-count you can see beats a double-count you cannot.
 *  - Reads one object at a time; parseLogFile deletes response bodies as it goes (the payload that
 *    OOMed a 4 GB heap in the PROJDAY backfill), so memory stays flat.
 *  - Never touches the watermark or any token counter.
 *
 *   AGGREGATES_TABLE=tums-aggregates-dev TENANTS_TABLE=tums-tenants-dev RAW_LOG_BUCKET=<bucket> \
 *   BACKFILL_UNTIL=2026-09-2xT..Z AWS_REGION=us-east-1 [CONCURRENCY=8] npx tsx scripts/backfill-latency.ts [--apply]
 *
 * Objects are processed CONCURRENCY at a time (default 8). The walk is latency-bound, not
 * bandwidth-bound — thousands of small objects, one round-trip each — so a sequential walk on a slow
 * link took hours; every object still claims its own marker and its ADDs are atomic, so order does
 * not matter. Progress is printed every 50 objects in both modes.
 */
import { S3Client, ListObjectsV2Command, GetObjectCommand } from '@aws-sdk/client-s3';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { gunzipSync } from 'zlib';
import {
  AttributionMaps, aggregate, aggregateByProject, aggregateByProjectDay, parseLogFile,
} from '../lambdas/ingestion/parse';
import { latencyOnlyAdd, latencyOnlyAddWithKeys } from '../lambdas/ingestion/latency-ddb';
import { loadAttributionMaps } from '../lambdas/shared/project-registry';

const s3 = new S3Client({});
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TABLE = process.env.AGGREGATES_TABLE!;
const BUCKET = process.env.RAW_LOG_BUCKET!;
const PREFIX = process.env.LOG_PREFIX ?? 'model-logs/AWSLogs/';
const UNTIL = process.env.BACKFILL_UNTIL ? Date.parse(process.env.BACKFILL_UNTIL) : NaN;
const APPLY = process.argv.includes('--apply');
const CONCURRENCY = Math.max(1, Number(process.env.CONCURRENCY ?? '8') || 8);
const MARKER_PK = 'SYSTEM#BACKFILL#latency';

async function listObjects(): Promise<{ key: string; lastModified: number }[]> {
  const out: { key: string; lastModified: number }[] = [];
  let token: string | undefined;
  do {
    const page = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: PREFIX, ContinuationToken: token }));
    for (const o of page.Contents ?? []) {
      const lm = o.LastModified?.getTime() ?? 0;
      // `/data/<uuid>_input.json.gz` etc. are bodies Bedrock offloaded to S3 (inputBodyS3Path), not
      // log records; they are large and carry no metrics.
      if (o.Key && lm > 0 && lm <= UNTIL && !o.Key.includes('/data/')) out.push({ key: o.Key, lastModified: lm });
    }
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
  return out.sort((a, b) => a.lastModified - b.lastModified);
}

async function markers(): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  let start: Record<string, unknown> | undefined;
  do {
    const page = await ddb.send(new QueryCommand({
      TableName: TABLE, KeyConditionExpression: 'pk = :pk', ExpressionAttributeValues: { ':pk': MARKER_PK }, ExclusiveStartKey: start,
    }));
    for (const it of page.Items ?? []) out.set(String(it.sk), String(it.state ?? 'done'));
    start = page.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (start);
  return out;
}

async function claim(key: string): Promise<boolean> {
  try {
    await ddb.send(new PutCommand({
      TableName: TABLE, Item: { pk: MARKER_PK, sk: key, state: 'claimed', claimedAt: new Date().toISOString() },
      ConditionExpression: 'attribute_not_exists(pk)',
    }));
    return true;
  } catch (e) {
    if ((e as Error).name === 'ConditionalCheckFailedException') return false;
    throw e;
  }
}

async function done(key: string, added: number): Promise<void> {
  await ddb.send(new UpdateCommand({
    TableName: TABLE, Key: { pk: MARKER_PK, sk: key },
    UpdateExpression: 'SET #s = :d, doneAt = :t, itemsAdded = :n',
    ExpressionAttributeNames: { '#s': 'state' },
    ExpressionAttributeValues: { ':d': 'done', ':t': new Date().toISOString(), ':n': added },
  }));
}

type Upd = { expression: string; values: Record<string, unknown>; names?: Record<string, string> };
async function addLatency(key: { pk: string; sk: string }, upd: Upd): Promise<void> {
  await ddb.send(new UpdateCommand({
    TableName: TABLE, Key: key, UpdateExpression: upd.expression,
    ExpressionAttributeValues: upd.values, ...(upd.names ? { ExpressionAttributeNames: upd.names } : {}),
  }));
}

async function main(): Promise<void> {
  if (!Number.isFinite(UNTIL)) {
    console.error('BACKFILL_UNTIL (ISO time the latency-aware aggregator was deployed) is required — objects after it already carry latency.');
    process.exit(2);
  }
  console.log(`table=${TABLE} bucket=${BUCKET} until=${new Date(UNTIL).toISOString()} mode=${APPLY ? 'APPLY' : 'DRY RUN (pass --apply to write)'}`);

  let maps: AttributionMaps | undefined;
  try { maps = await loadAttributionMaps(); } catch (e) { console.warn('attribution maps unavailable; records attribute by metadata only:', (e as Error).message); }

  const objects = await listObjects();
  const seen = await markers();
  const stuck = [...seen].filter(([, st]) => st !== 'done').map(([k]) => k);
  if (stuck.length) console.warn(`⚠️  ${stuck.length} object(s) claimed but never finished — NOT re-added; inspect by hand:\n  ${stuck.join('\n  ')}`);
  const todo = objects.filter((o) => !seen.has(o.key));
  console.log(`${objects.length} object(s) before the cut-off, ${seen.size} already marked, ${todo.length} to process`);

  let objectsDone = 0, itemsAdded = 0, samples = 0, skippedNoLatency = 0, walked = 0;
  const started = Date.now();
  const progress = () => {
    walked += 1;
    if (walked % 50 === 0 || walked === todo.length) {
      const secs = Math.round((Date.now() - started) / 1000);
      console.log(`  … ${walked}/${todo.length} objects walked, ${objectsDone} with latency, ${itemsAdded} item ADDs, ${samples} samples, ${secs}s`);
    }
  };

  const processOne = async (o: { key: string; lastModified: number }): Promise<void> => {
    const body = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: o.key }));
    const raw = Buffer.from(await body.Body!.transformToByteArray());
    const text = o.key.endsWith('.gz') ? gunzipSync(raw).toString('utf8') : raw.toString('utf8');
    const records = parseLogFile(text); // bodies are gone after this line
    const withLatency = records.filter((r) => r.latency).length;
    // No marker for a body-less object: it adds nothing, so re-walking it on a re-run is harmless
    // and cheaper than a marker item per object (there are hundreds of thousands of them).
    if (withLatency === 0) { skippedNoLatency += 1; return; }

    const hourly = aggregate(records, maps);
    const byProject = aggregateByProject(records, maps);
    const byDay = aggregateByProjectDay(records, maps);
    // Keyed rollups carry their identifying attributes too (if_not_exists), so an ADD onto a key with
    // no item cannot leave a bare, reader-invisible row behind.
    const plan: { key: { pk: string; sk: string }; upd: Upd }[] = [];
    for (const a of hourly.values()) {
      const u = latencyOnlyAdd(a.latency); if (!u) continue;
      plan.push({ key: { pk: `TENANT#${a.tenant}#USAGE`, sk: a.hourBucket }, upd: u });
      const m = latencyOnlyAddWithKeys(a.latency, { modelId: a.modelId });
      if (m) plan.push({ key: { pk: `TENANT#${a.tenant}#MODEL`, sk: a.modelId }, upd: m });
    }
    for (const p of byProject.values()) {
      const u = latencyOnlyAddWithKeys(p.latency, { projectId: p.projectId, modelId: p.modelId });
      if (u) plan.push({ key: { pk: `TENANT#${p.tenant}#PROJECT`, sk: `${p.projectId}#${p.modelId}` }, upd: u });
    }
    for (const d of byDay.values()) {
      const u = latencyOnlyAddWithKeys(d.latency, { day: d.day, projectId: d.projectId, modelId: d.modelId });
      if (u) plan.push({ key: { pk: `TENANT#${d.tenant}#PROJDAY`, sk: `${d.day}#${d.projectId}#${d.modelId}` }, upd: u });
    }

    if (!APPLY) { samples += withLatency; itemsAdded += plan.length; objectsDone += 1; return; }
    if (!(await claim(o.key))) return; // raced by another run
    for (const step of plan) await addLatency(step.key, step.upd);
    await done(o.key, plan.length);
    samples += withLatency; itemsAdded += plan.length; objectsDone += 1;
  };

  // Fixed-size worker pool over the sorted todo list.
  let next = 0;
  const worker = async () => {
    while (next < todo.length) {
      const o = todo[next]; next += 1;
      try { await processOne(o); } catch (e) { console.error(`✗ ${o.key}: ${(e as Error).message}`); }
      progress();
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, todo.length) }, worker));
  console.log(`${APPLY ? 'applied' : 'would apply'}: ${objectsDone} object(s) with latency, ${skippedNoLatency} without a logged body (nothing to add, no marker), ${itemsAdded} item ADD(s), ${samples} sample(s)`);
  if (!APPLY) console.log('dry run — no writes performed.');
}

main().catch((e) => { console.error(e); process.exit(1); });
