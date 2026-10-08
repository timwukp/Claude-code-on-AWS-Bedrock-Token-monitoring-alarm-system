/**
 * Read-only check that the cache-write counters agree across the four rollups after
 * `backfill-cache-write.ts` (feature-36). Prints one block per tenant and a marker census; exits 1
 * when any rollup's total differs from USAGE's by more than TOLERANCE_TOKENS or when any marker is
 * still `claimed`.
 *
 * Why USAGE is the reference: it stored `cacheWriteTokens` from the first day, so its per-tenant sum
 * is the complete figure; MODEL / PROJECT / PROJDAY got theirs from the backfill plus the new
 * aggregator, and a gap between them is exactly what the backfill missed (a crash mid-object leaves
 * a `claimed` marker and a visible under-count, never a double-count).
 *
 *   AGGREGATES_TABLE=tums-aggregates-dev AWS_REGION=us-east-1 [TOLERANCE_TOKENS=0] \
 *     npx tsx scripts/verify-cache-write-backfill.ts [--json out.json]
 */
import * as fs from 'fs';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TABLE = process.env.AGGREGATES_TABLE!;
const TOLERANCE = Number(process.env.TOLERANCE_TOKENS ?? '0') || 0;
const MARKER_PK = 'SYSTEM#BACKFILL#cachewrite';
const KINDS = ['USAGE', 'MODEL', 'PROJECT', 'PROJDAY'] as const;
type Kind = (typeof KINDS)[number];
type Sums = { cacheWriteTokens: number; cacheWrite5mTokens: number; cacheWrite1hTokens: number; items: number; splitExceedsTotal: number };

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** Every tenant that has a USAGE partition, discovered by scanning pk values once. */
async function tenants(): Promise<string[]> {
  const out = new Set<string>();
  let start: Record<string, unknown> | undefined;
  do {
    const page = await ddb.send(new ScanCommand({
      TableName: TABLE, ProjectionExpression: 'pk', ExclusiveStartKey: start,
      FilterExpression: 'begins_with(pk, :t) AND contains(pk, :u)', ExpressionAttributeValues: { ':t': 'TENANT#', ':u': '#USAGE' },
    }));
    for (const it of page.Items ?? []) out.add(String(it.pk).slice('TENANT#'.length, -'#USAGE'.length));
    start = page.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (start);
  return [...out].sort();
}

async function sums(tenant: string, kind: Kind): Promise<Sums> {
  const s: Sums = { cacheWriteTokens: 0, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0, items: 0, splitExceedsTotal: 0 };
  let start: Record<string, unknown> | undefined;
  do {
    const page = await ddb.send(new QueryCommand({
      TableName: TABLE, KeyConditionExpression: 'pk = :pk', ExpressionAttributeValues: { ':pk': `TENANT#${tenant}#${kind}` },
      ProjectionExpression: 'cacheWriteTokens, cacheWrite5mTokens, cacheWrite1hTokens', ExclusiveStartKey: start,
    }));
    for (const it of page.Items ?? []) {
      s.cacheWriteTokens += num(it.cacheWriteTokens); s.cacheWrite5mTokens += num(it.cacheWrite5mTokens);
      s.cacheWrite1hTokens += num(it.cacheWrite1hTokens); s.items += 1;
      // No single pass can write a TTL split larger than the total it splits; a retried ADD can.
      if (num(it.cacheWrite5mTokens) + num(it.cacheWrite1hTokens) > num(it.cacheWriteTokens)) s.splitExceedsTotal += 1;
    }
    start = page.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (start);
  return s;
}

async function markerCensus(): Promise<{ done: number; claimed: number; claimedKeys: string[]; tokensDone: number }> {
  const out = { done: 0, claimed: 0, claimedKeys: [] as string[], tokensDone: 0 };
  let start: Record<string, unknown> | undefined;
  do {
    const page = await ddb.send(new QueryCommand({
      TableName: TABLE, KeyConditionExpression: 'pk = :pk', ExpressionAttributeValues: { ':pk': MARKER_PK }, ExclusiveStartKey: start,
    }));
    for (const it of page.Items ?? []) {
      if (it.state === 'done') { out.done += 1; out.tokensDone += num(it.cacheWriteTokens); } else { out.claimed += 1; out.claimedKeys.push(String(it.sk)); }
    }
    start = page.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (start);
  return out;
}

async function main(): Promise<void> {
  const report: Record<string, unknown> = { table: TABLE, checkedAt: new Date().toISOString(), toleranceTokens: TOLERANCE, tenants: [] as unknown[] };
  let failures = 0;
  for (const t of await tenants()) {
    const by = Object.fromEntries(await Promise.all(KINDS.map(async (k) => [k, await sums(t, k)]))) as Record<Kind, Sums>;
    if (by.USAGE.cacheWriteTokens === 0) continue; // tenant never wrote to the cache; nothing to compare
    const gaps = Object.fromEntries(KINDS.filter((k) => k !== 'USAGE').map((k) => [k, by.USAGE.cacheWriteTokens - by[k].cacheWriteTokens])) as Record<Exclude<Kind, 'USAGE'>, number>;
    const overSplit = KINDS.reduce((n, k) => n + by[k].splitExceedsTotal, 0);
    const bad = Object.values(gaps).some((g) => Math.abs(g) > TOLERANCE) || overSplit > 0;
    if (bad) failures += 1;
    (report.tenants as unknown[]).push({ tenant: t.replace(/[0-9]{12}/g, '<ACCT>'), by, gaps, ok: !bad });
    console.log(`${bad ? '✗' : '✓'} ${t.replace(/[0-9]{12}/g, '<ACCT>')}`);
    for (const k of KINDS) console.log(`    ${k.padEnd(8)} cw=${by[k].cacheWriteTokens} 5m=${by[k].cacheWrite5mTokens} 1h=${by[k].cacheWrite1hTokens} items=${by[k].items}${by[k].splitExceedsTotal ? ` SPLIT>TOTAL on ${by[k].splitExceedsTotal} item(s)` : ''}${k === 'USAGE' ? '' : `  gap vs USAGE=${gaps[k as Exclude<Kind, 'USAGE'>]}`}`);
  }
  const markers = await markerCensus();
  report.markers = markers;
  console.log(`markers: ${markers.done} done (${markers.tokensDone} cw tokens), ${markers.claimed} claimed-not-done`);
  for (const k of markers.claimedKeys) console.log(`  stuck: ${k.replace(/[0-9]{12}/g, '<ACCT>')}`);
  if (markers.claimed > 0) failures += 1;
  report.ok = failures === 0;
  const idx = process.argv.indexOf('--json');
  if (idx >= 0 && process.argv[idx + 1]) fs.writeFileSync(process.argv[idx + 1], JSON.stringify(report, null, 2));
  console.log(report.ok ? 'VERIFY PASSED' : `VERIFY FAILED (${failures} problem(s))`);
  process.exit(report.ok ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(2); });
