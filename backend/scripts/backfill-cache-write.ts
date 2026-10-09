/**
 * One-off backfill of the cache-write counters (feature-36) onto rollup items the aggregator wrote
 * BEFORE it stored them. Until feature-36 only the USAGE item carried `cacheWriteTokens`; MODEL,
 * PROJECT and PROJDAY carried nothing, and no item carried the TTL split — so the bill's largest token
 * line (cache writes, 37% of Jun–Oct spend here) was priced at $0 on every page but Usage. The other
 * token counters are not touched — they were rolled up correctly the first time. Added:
 *   USAGE                    cacheWrite5mTokens, cacheWrite1hTokens            (total already there)
 *   MODEL / PROJECT / PROJDAY cacheWriteTokens, cacheWrite5mTokens, cacheWrite1hTokens
 *
 * Why a cut-off and not the watermark: the aggregator keeps no per-object ledger, only a high-water
 * mark. Every object it processed AFTER the cache-write-aware build was deployed already carries the
 * counters, so re-adding those would double-count. BACKFILL_UNTIL is therefore REQUIRED and must be
 * the deploy time of that build; only objects with lastModified <= BACKFILL_UNTIL are read.
 *
 * Safety, in the style of backfill-latency.ts:
 *  - DRY RUN BY DEFAULT: lists what it would add and exits; `--apply` is required to write.
 *  - Per-object claim marker `SYSTEM#BACKFILL#cachewrite` / `<objectKey>` written with
 *    attribute_not_exists BEFORE the ADDs and flipped to state=done AFTER — for objects that carry
 *    cache writes; objects with none add nothing and get no marker. A re-run skips done objects, and
 *    REPORTS claimed-but-not-done ones (a crash mid-object) instead of re-adding them — an
 *    under-count you can see beats a double-count you cannot.
 *  - Reads one object at a time; parseLogFile lifts the TTL split and deletes response bodies as it
 *    goes (the payload that OOMed a 4 GB heap in the PROJDAY backfill), so memory stays flat.
 *  - Never touches the watermark or any other token counter.
 *
 * Unlike latency, the cache-write TOTAL is on the record itself, not in the body — so almost every
 * object adds something and gets a marker (≈ one marker per log object; at on-demand DynamoDB prices
 * a few hundred thousand objects cost well under a dollar). The TTL split is only added where the
 * body was logged and carried it; the rest stays "TTL unknown" and prices at 5 m with a 1 h bound.
 *
 *   AGGREGATES_TABLE=tums-aggregates-dev TENANTS_TABLE=tums-tenants-dev RAW_LOG_BUCKET=<bucket> \
 *   BACKFILL_UNTIL=2026-10-0xT..Z AWS_REGION=us-east-1 [CONCURRENCY=8] npx tsx scripts/backfill-cache-write.ts [--apply]
 *
 * The dry run prints the cache-write token total it would add; compare it with Athena's all-time
 * SUM(input.cacheWriteInputTokenCount) before applying — they must agree.
 */
import { S3Client, ListObjectsV2Command, GetObjectCommand } from '@aws-sdk/client-s3';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { gunzipSync } from 'zlib';
import {
  AttributionMaps, aggregate, aggregateByProject, aggregateByProjectDay, parseLogFile,
} from '../lambdas/ingestion/parse';
import { CacheWriteOnlyAdd, cacheWriteOnlyAdd } from '../lambdas/ingestion/cache-write-ddb';
import { loadAttributionMaps } from '../lambdas/shared/project-registry';

const s3 = new S3Client({});
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TABLE = process.env.AGGREGATES_TABLE!;
const BUCKET = process.env.RAW_LOG_BUCKET!;
const PREFIX = process.env.LOG_PREFIX ?? 'model-logs/AWSLogs/';
const UNTIL = process.env.BACKFILL_UNTIL ? Date.parse(process.env.BACKFILL_UNTIL) : NaN;
const APPLY = process.argv.includes('--apply');
const CONCURRENCY = Math.max(1, Number(process.env.CONCURRENCY ?? '8') || 8);
const MARKER_PK = 'SYSTEM#BACKFILL#cachewrite';

async function listObjects(): Promise<{ key: string; lastModified: number }[]> {
  const out: { key: string; lastModified: number }[] = [];
  let token: string | undefined;
  do {
    const page = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: PREFIX, ContinuationToken: token }));
    for (const o of page.Contents ?? []) {
      const lm = o.LastModified?.getTime() ?? 0;
      // `/data/<uuid>_input.json.gz` etc. are bodies Bedrock offloaded to S3 (inputBodyS3Path), not
      // log records; permission-check markers carry no tokens either.
      if (o.Key && lm > 0 && lm <= UNTIL && !o.Key.includes('/data/') && !o.Key.includes('permission-check')) {
        out.push({ key: o.Key, lastModified: lm });
      }
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

async function done(key: string, added: number, tokens: number): Promise<void> {
  await ddb.send(new UpdateCommand({
    TableName: TABLE, Key: { pk: MARKER_PK, sk: key },
    UpdateExpression: 'SET #s = :d, doneAt = :t, itemsAdded = :n, cacheWriteTokens = :cw',
    ExpressionAttributeNames: { '#s': 'state' },
    ExpressionAttributeValues: { ':d': 'done', ':t': new Date().toISOString(), ':n': added, ':cw': tokens },
  }));
}

async function addCounters(key: { pk: string; sk: string }, upd: CacheWriteOnlyAdd): Promise<void> {
  await ddb.send(new UpdateCommand({
    TableName: TABLE, Key: key, UpdateExpression: upd.expression,
    ExpressionAttributeValues: upd.values,
    ...(Object.keys(upd.names).length ? { ExpressionAttributeNames: upd.names } : {}),
  }));
}

async function main(): Promise<void> {
  if (!Number.isFinite(UNTIL)) {
    console.error('BACKFILL_UNTIL (ISO time the cache-write-aware aggregator was deployed) is required — objects after it already carry the counters.');
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

  let objectsDone = 0, itemsAdded = 0, tokens = 0, tokens5m = 0, tokens1h = 0, skippedNoWrites = 0, walked = 0;
  const started = Date.now();
  const progress = () => {
    walked += 1;
    if (walked % 50 === 0 || walked === todo.length) {
      const secs = Math.round((Date.now() - started) / 1000);
      console.log(`  … ${walked}/${todo.length} objects walked, ${objectsDone} with cache writes, ${itemsAdded} item ADDs, ${tokens} cw tokens (${tokens5m} 5m / ${tokens1h} 1h), ${secs}s`);
    }
  };

  const processOne = async (o: { key: string; lastModified: number }): Promise<void> => {
    const body = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: o.key }));
    const raw = Buffer.from(await body.Body!.transformToByteArray());
    const text = o.key.endsWith('.gz') ? gunzipSync(raw).toString('utf8') : raw.toString('utf8');
    const records = parseLogFile(text); // bodies are gone after this line; TTL split is on the records
    const hourly = aggregate(records, maps);
    let objTokens = 0, obj5m = 0, obj1h = 0;
    for (const a of hourly.values()) { objTokens += a.cacheWriteTokens; obj5m += a.cacheWrite5mTokens; obj1h += a.cacheWrite1hTokens; }
    // No marker for an object without cache writes: it adds nothing, so re-walking it on a re-run is
    // harmless and cheaper than a marker item.
    if (objTokens === 0) { skippedNoWrites += 1; return; }

    const byProject = aggregateByProject(records, maps);
    const byDay = aggregateByProjectDay(records, maps);
    const plan: { key: { pk: string; sk: string }; upd: CacheWriteOnlyAdd }[] = [];
    for (const a of hourly.values()) {
      const u = cacheWriteOnlyAdd(a, { includeTotal: false }); // USAGE stored the total all along
      if (u) plan.push({ key: { pk: `TENANT#${a.tenant}#USAGE`, sk: a.hourBucket }, upd: u });
      const m = cacheWriteOnlyAdd(a, { includeTotal: true, keys: { modelId: a.modelId } });
      if (m) plan.push({ key: { pk: `TENANT#${a.tenant}#MODEL`, sk: a.modelId }, upd: m });
    }
    for (const p of byProject.values()) {
      const u = cacheWriteOnlyAdd(p, { includeTotal: true, keys: { projectId: p.projectId, modelId: p.modelId } });
      if (u) plan.push({ key: { pk: `TENANT#${p.tenant}#PROJECT`, sk: `${p.projectId}#${p.modelId}` }, upd: u });
    }
    for (const d of byDay.values()) {
      const u = cacheWriteOnlyAdd(d, { includeTotal: true, keys: { day: d.day, projectId: d.projectId, modelId: d.modelId } });
      if (u) plan.push({ key: { pk: `TENANT#${d.tenant}#PROJDAY`, sk: `${d.day}#${d.projectId}#${d.modelId}` }, upd: u });
    }

    const tally = () => { tokens += objTokens; tokens5m += obj5m; tokens1h += obj1h; itemsAdded += plan.length; objectsDone += 1; };
    if (!APPLY) { tally(); return; }
    if (!(await claim(o.key))) return; // raced by another run
    for (const step of plan) await addCounters(step.key, step.upd);
    await done(o.key, plan.length, objTokens);
    tally();
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
  console.log(`${APPLY ? 'applied' : 'would apply'}: ${objectsDone} object(s) with cache writes, ${skippedNoWrites} without (nothing to add, no marker), ${itemsAdded} item ADD(s), ${tokens} cache-write tokens (${tokens5m} known 5m, ${tokens1h} known 1h, ${tokens - tokens5m - tokens1h} TTL unknown)`);
  if (!APPLY) console.log('dry run — no writes performed. Compare the token total with Athena SUM(input.cacheWriteInputTokenCount) before --apply.');
}

main().catch((e) => { console.error(e); process.exit(1); });
