/**
 * Reconcile the cache-write counters on every rollup item against the raw logs, and ADD exactly what
 * is missing (feature-36). Companion to backfill-cache-write.ts for the one case that script refuses
 * to handle: an object whose marker says `claimed` but not `done` — some of its ADDs landed, some did
 * not, and nobody knows which. Re-adding the object would double-count; this script instead derives
 * the TRUTH for every item from all objects and compares it with what is stored.
 *
 * Truth = fold every log object (no cut-off: the live aggregator's objects are included, so truth is
 * the complete figure) with the same parse/aggregate code the aggregator and the backfill use, keyed
 * exactly as the four writers key their items. Delta = truth − stored, per item, per counter.
 *   delta > 0 → missing; ADDed with --apply.
 *   delta = 0 → the common case; nothing written.
 *   delta < 0 → stored exceeds truth: a double-count or a bug. NOT corrected by default; the run reports
 *               it and exits 1, because subtracting on a guess hides the cause. `--correct-over-counts`
 *               applies the negative deltas too, and is meant for exactly one established cause: an
 *               `ADD` whose response was lost on a flaky link is RETRIED by the AWS SDK and lands twice.
 *               The first backfill ran on a laptop that lost its network mid-run (2026-10-06/07), and
 *               five items on the two affected days came out over by one object's worth — including a
 *               USAGE hour whose 5-minute split exceeded its own total, which no single pass can produce.
 *
 * Race with the live aggregator: the watermark is read before the walk and again before the writes; if
 * it moved, the newly folded objects are walked too (incrementally) and the comparison is redone, so a
 * delta is never computed against items the aggregator was changing underneath.
 *
 * Idempotent by construction: a re-run recomputes deltas from the current stored values, so an
 * interrupted apply simply finishes on the next run. No marker is needed. On a healthy table a re-run
 * reports all-zero deltas; that makes it a drift check as well as a repair.
 *
 *   AGGREGATES_TABLE=tums-aggregates-dev TENANTS_TABLE=tums-tenants-dev RAW_LOG_BUCKET=<bucket> \
 *   AWS_REGION=us-east-1 [CONCURRENCY=32] npx tsx scripts/reconcile-cache-write.ts [--apply] [--json out.json]
 */
import * as fs from 'fs';
import { S3Client, ListObjectsV2Command, GetObjectCommand } from '@aws-sdk/client-s3';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, QueryCommand, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { gunzipSync } from 'zlib';
import {
  AttributionMaps, CacheWriteCounters, aggregate, aggregateByProject, aggregateByProjectDay, mergeCacheWrite, parseLogFile,
} from '../lambdas/ingestion/parse';
import { cacheWriteOnlyAdd } from '../lambdas/ingestion/cache-write-ddb';
import { loadAttributionMaps } from '../lambdas/shared/project-registry';

const s3 = new S3Client({});
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TABLE = process.env.AGGREGATES_TABLE!;
const BUCKET = process.env.RAW_LOG_BUCKET!;
const PREFIX = process.env.LOG_PREFIX ?? 'model-logs/AWSLogs/';
const APPLY = process.argv.includes('--apply');
const CORRECT_OVER = process.argv.includes('--correct-over-counts');
const CONCURRENCY = Math.max(1, Number(process.env.CONCURRENCY ?? '32') || 32);
const COUNTERS = ['cacheWriteTokens', 'cacheWrite5mTokens', 'cacheWrite1hTokens'] as const;

type Key = { pk: string; sk: string };
type Truth = Map<string, { key: Key; keys: Record<string, string>; c: CacheWriteCounters }>;
const kid = (k: Key) => `${k.pk}\u0000${k.sk}`;
const zero = (): CacheWriteCounters => ({ cacheWriteTokens: 0, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0 });

async function watermark(): Promise<number> {
  const r = await ddb.send(new GetCommand({ TableName: TABLE, Key: { pk: 'SYSTEM#WATERMARK', sk: 'aggregator' } }));
  return Number(r.Item?.lastModified ?? 0);
}

async function listObjects(after: number, upTo: number): Promise<{ key: string; lastModified: number }[]> {
  const out: { key: string; lastModified: number }[] = [];
  let token: string | undefined;
  do {
    const page = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: PREFIX, ContinuationToken: token }));
    for (const o of page.Contents ?? []) {
      const lm = o.LastModified?.getTime() ?? 0;
      if (o.Key && lm > after && lm <= upTo && !o.Key.includes('/data/') && !o.Key.includes('permission-check')) out.push({ key: o.Key, lastModified: lm });
    }
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
  return out.sort((a, b) => a.lastModified - b.lastModified);
}

/** Fold one object's records into the truth map under the four writers' keys. */
function fold(truth: Truth, text: string, maps: AttributionMaps | undefined): number {
  const records = parseLogFile(text);
  const put = (key: Key, keys: Record<string, string>, c: CacheWriteCounters) => {
    const e = truth.get(kid(key)) ?? { key, keys, c: zero() };
    mergeCacheWrite(e.c, c); truth.set(kid(key), e);
  };
  let tokens = 0;
  for (const a of aggregate(records, maps).values()) {
    tokens += a.cacheWriteTokens;
    put({ pk: `TENANT#${a.tenant}#USAGE`, sk: a.hourBucket }, {}, a);
    put({ pk: `TENANT#${a.tenant}#MODEL`, sk: a.modelId }, { modelId: a.modelId }, a);
  }
  for (const p of aggregateByProject(records, maps).values()) put({ pk: `TENANT#${p.tenant}#PROJECT`, sk: `${p.projectId}#${p.modelId}` }, { projectId: p.projectId, modelId: p.modelId }, p);
  for (const d of aggregateByProjectDay(records, maps).values()) put({ pk: `TENANT#${d.tenant}#PROJDAY`, sk: `${d.day}#${d.projectId}#${d.modelId}` }, { day: d.day, projectId: d.projectId, modelId: d.modelId }, d);
  return tokens;
}

async function walk(truth: Truth, objects: { key: string }[], maps: AttributionMaps | undefined): Promise<number> {
  let next = 0, tokens = 0, walked = 0; const started = Date.now();
  const worker = async () => {
    while (next < objects.length) {
      const o = objects[next]; next += 1;
      for (let attempt = 1; ; attempt += 1) {
        try {
          const r = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: o.key }));
          const raw = Buffer.from(await r.Body!.transformToByteArray());
          tokens += fold(truth, o.key.endsWith('.gz') ? gunzipSync(raw).toString('utf8') : raw.toString('utf8'), maps);
          break;
        } catch (e) {
          // A read that fails for good would make truth SMALLER than stored and show up as a negative delta,
          // which the run refuses to act on — so retry hard rather than skip.
          if (attempt >= 6) throw new Error(`${o.key}: ${(e as Error).message} after ${attempt} attempts`);
          await new Promise((res) => setTimeout(res, 500 * 2 ** attempt));
        }
      }
      walked += 1;
      if (walked % 2000 === 0 || walked === objects.length) console.log(`  … ${walked}/${objects.length} objects, ${tokens} cw tokens, ${Math.round((Date.now() - started) / 1000)}s`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, objects.length) }, worker));
  return tokens;
}

/** Stored counters for every rollup item of the four kinds (one scan, projected). */
async function stored(): Promise<Map<string, CacheWriteCounters>> {
  const out = new Map<string, CacheWriteCounters>();
  let start: Record<string, unknown> | undefined;
  do {
    const page = await ddb.send(new ScanCommand({
      TableName: TABLE, ExclusiveStartKey: start,
      FilterExpression: 'begins_with(pk, :t)', ExpressionAttributeValues: { ':t': 'TENANT#' },
      ProjectionExpression: 'pk, sk, cacheWriteTokens, cacheWrite5mTokens, cacheWrite1hTokens',
    }));
    for (const it of page.Items ?? []) {
      const pk = String(it.pk);
      if (!/#(USAGE|MODEL|PROJECT|PROJDAY)$/.test(pk)) continue;
      out.set(kid({ pk, sk: String(it.sk) }), {
        cacheWriteTokens: Number(it.cacheWriteTokens ?? 0), cacheWrite5mTokens: Number(it.cacheWrite5mTokens ?? 0), cacheWrite1hTokens: Number(it.cacheWrite1hTokens ?? 0),
      });
    }
    start = page.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (start);
  return out;
}

async function main(): Promise<void> {
  console.log(`table=${TABLE} bucket=${BUCKET} mode=${APPLY ? 'APPLY' : 'DRY RUN (pass --apply to write)'}`);
  let maps: AttributionMaps | undefined;
  try { maps = await loadAttributionMaps(); } catch (e) { console.warn('attribution maps unavailable:', (e as Error).message); }

  // Truth up to the aggregator's watermark, then catch up until the watermark holds still.
  const truth: Truth = new Map();
  let folded = 0, totalTokens = 0;
  let w = await watermark();
  for (let round = 1; ; round += 1) {
    const objs = await listObjects(folded, w);
    console.log(`round ${round}: ${objs.length} object(s) with lastModified in (${new Date(folded).toISOString()}, ${new Date(w).toISOString()}]`);
    totalTokens += await walk(truth, objs, maps);
    folded = w;
    const w2 = await watermark();
    if (w2 === w) break;
    w = w2; // the aggregator ran meanwhile; fold what it folded, then compare
  }
  console.log(`truth: ${truth.size} item(s), ${totalTokens} cw tokens, watermark ${new Date(w).toISOString()}`);

  const have = await stored();
  // Every truth item must exist in the table (the writers create them); a truth item with no stored
  // row would mean the writers and this script disagree on a key — report, never create.
  const plan: { key: Key; keys: Record<string, string>; delta: CacheWriteCounters }[] = [];
  const negatives: string[] = [], missingRows: string[] = [];
  let itemsOff = 0, itemsOver = 0;
  for (const [id, t] of truth) {
    const s = have.get(id);
    if (!s) { if (COUNTERS.some((c) => t.c[c] > 0)) missingRows.push(`${t.key.pk} / ${t.key.sk}`); continue; }
    const delta = zero(); let any = false, neg = false;
    for (const c of COUNTERS) { delta[c] = t.c[c] - s[c]; if (delta[c] > 0) any = true; if (delta[c] < 0) neg = true; }
    if (neg) {
      negatives.push(`${t.key.pk.replace(/[0-9]{12}/g, '<ACCT>')} / ${t.key.sk}: ${COUNTERS.map((c) => `${c} truth=${t.c[c]} stored=${s[c]}`).join(', ')}`);
      if (CORRECT_OVER) { itemsOver += 1; plan.push({ key: t.key, keys: t.keys, delta }); } // ADD of a negative = the exact correction
    } else if (any) { itemsOff += 1; plan.push({ key: t.key, keys: t.keys, delta }); }
  }
  // Stored items the truth never produced (nothing in the logs maps to them): only a problem if they carry counters.
  for (const [id, s] of have) if (!truth.has(id) && COUNTERS.some((c) => s[c] > 0)) negatives.push(`${id.split('\u0000')[0].replace(/[0-9]{12}/g, '<ACCT>')} / ${id.split('\u0000')[1]}: stored but no log object maps to it (${JSON.stringify(s)})`);

  const sum = (c: typeof COUNTERS[number], sign: 1 | -1) => plan.reduce((n, p) => n + (Math.sign(p.delta[c]) === sign ? p.delta[c] : 0), 0);
  console.log(`compared ${truth.size} items: ${truth.size - itemsOff - itemsOver - missingRows.length} exact, ${itemsOff} short, ${negatives.length} over/unmapped${CORRECT_OVER ? ` (${itemsOver} will be corrected)` : ''}, ${missingRows.length} missing rows`);
  console.log(`missing (would ADD): cacheWriteTokens ${sum('cacheWriteTokens', 1)}, cacheWrite5mTokens ${sum('cacheWrite5mTokens', 1)}, cacheWrite1hTokens ${sum('cacheWrite1hTokens', 1)}`);
  if (CORRECT_OVER) console.log(`over (would SUBTRACT): cacheWriteTokens ${-sum('cacheWriteTokens', -1)}, cacheWrite5mTokens ${-sum('cacheWrite5mTokens', -1)}, cacheWrite1hTokens ${-sum('cacheWrite1hTokens', -1)}`);
  for (const p of plan) console.log(`  ${COUNTERS.some((c) => p.delta[c] < 0) ? '−' : '+'} ${p.key.pk.replace(/[0-9]{12}/g, '<ACCT>')} / ${p.key.sk}: ${COUNTERS.filter((c) => p.delta[c] !== 0).map((c) => `${c}${p.delta[c] > 0 ? '+' : ''}${p.delta[c]}`).join(' ')}`);
  for (const n of negatives) console.log(`  ✗ ${n}`);
  for (const m of missingRows) console.log(`  ? no stored row: ${m.replace(/[0-9]{12}/g, '<ACCT>')}`);

  const idx = process.argv.indexOf('--json');
  const report = { checkedAt: new Date().toISOString(), watermark: new Date(w).toISOString(), truthItems: truth.size, truthTokens: totalTokens, short: itemsOff, over: negatives, correctingOver: CORRECT_OVER, missingRows, missing: { cacheWriteTokens: sum('cacheWriteTokens', 1), cacheWrite5mTokens: sum('cacheWrite5mTokens', 1), cacheWrite1hTokens: sum('cacheWrite1hTokens', 1) }, overBy: { cacheWriteTokens: -sum('cacheWriteTokens', -1), cacheWrite5mTokens: -sum('cacheWrite5mTokens', -1), cacheWrite1hTokens: -sum('cacheWrite1hTokens', -1) }, applied: 0 };
  if ((negatives.length && !CORRECT_OVER) || missingRows.length) {
    if (idx >= 0) fs.writeFileSync(process.argv[idx + 1], JSON.stringify(report, null, 2));
    console.error('REFUSING to write: stored exceeds truth somewhere, or a row is missing — investigate first.');
    process.exit(1);
  }
  if (!APPLY) { if (idx >= 0) fs.writeFileSync(process.argv[idx + 1], JSON.stringify(report, null, 2)); console.log('dry run — no writes performed.'); return; }

  if ((await watermark()) !== w) { console.error('aggregator ran during the comparison — re-run.'); process.exit(3); }
  for (const p of plan) {
    const u = cacheWriteOnlyAdd(p.delta, { includeTotal: true, keys: p.keys, allowNegative: CORRECT_OVER });
    if (!u) continue;
    await ddb.send(new UpdateCommand({
      TableName: TABLE, Key: p.key, UpdateExpression: u.expression, ExpressionAttributeValues: u.values,
      ...(Object.keys(u.names).length ? { ExpressionAttributeNames: u.names } : {}),
    }));
    report.applied += 1;
  }
  if (idx >= 0) fs.writeFileSync(process.argv[idx + 1], JSON.stringify(report, null, 2));
  console.log(`applied ${report.applied} item ADD(s). Re-run without --apply: every delta must now be 0.`);
}

main().catch((e) => { console.error(e); process.exit(2); });
