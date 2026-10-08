/**
 * One-off repair of the PROJDAY rollups for ONE day whose token counters were double-counted.
 *
 * Why it exists: on 2026-09-17 the PROJDAY items for the demo tenant carry +231 invocations,
 * +12,380 input and +146,311 output tokens more than the hourly USAGE rollups and more than the raw
 * logs (confirmed by Athena COUNT(DISTINCT requestId) on #59). Every other day reconciles to the
 * token. The shape is cross-run double processing on the boundary day of feature-13's PROJDAY
 * backfill. Since #57 moved the Cost page onto PROJDAY, the over-count shows up on screen as a
 * Usage-vs-Cost mismatch (qa F-PR61-001).
 *
 * Where the surplus sits: on the boundary day the feature-13 backfill's one-time HOUR_PROJECT_MAP
 * moved records out of `untagged` into project rows. Re-deriving those records with the aggregator's
 * own attribution puts them back under `untagged`, so a naive item − truth is NEGATIVE on `untagged`
 * and POSITIVE on the moved project rows — a moved population, not a double count. Accounting for the
 * move gives the exact surplus per model:
 *     surplus(model) = untagged item − (untagged truth − Σ project items of that model)
 * and every one of those figures matched the independent Athena per-model deltas on #59 to the
 * token (fable-5 +58 inv, opus-5 +137, sonnet-4-6 +36, haiku 0). The double count is entirely on
 * the `untagged` rows, so that is where the negative ADD goes. Project rows are never touched.
 *
 * How it decides what is true: it does NOT use Athena. It re-parses the raw S3 objects for the day
 * (plus the following hour, for boundary spill) through the aggregator's OWN code path —
 * parseLogFile → aggregateByProjectDay with loadAttributionMaps, i.e. all four attribution tiers —
 * and keeps the records whose day bucket is the target day. An Athena-only truth misattributes the
 * identity-hint tier and fails the checks below (tried on #59: Σ = −504).
 *
 * Safety:
 *  - DRY RUN BY DEFAULT; `--apply` required.
 *  - Three assertions must hold or nothing is written: every moved project row has truth 0 (it is
 *    purely a treatment row); every per-model surplus is ≥ 0 for every counter; and Σ surplus
 *    invocations equals EXPECT_DELTA_INV when given (the independently confirmed figure).
 *  - Only the token counters are touched (inputTokens, outputTokens, cacheReadTokens, the three
 *    cacheWrite* counters since feature-36,
 *    invocations), by negative ADD. Latency attributes are never read or written.
 *  - Guarded by marker `SYSTEM#REPAIR#projday` / `<day>` with attribute_not_exists; a second run
 *    refuses. Truth rows that have no PROJDAY item are reported, not created.
 *
 *   AGGREGATES_TABLE=tums-aggregates-dev TENANTS_TABLE=tums-tenants-dev RAW_LOG_BUCKET=<bucket> \
 *   TENANT=<tenantId> DAY=2026-09-17 [EXPECT_DELTA_INV=231] AWS_REGION=us-east-1 \
 *   npx tsx scripts/repair-projday-day.ts [--apply]
 */
import { S3Client, ListObjectsV2Command, GetObjectCommand } from '@aws-sdk/client-s3';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { gunzipSync } from 'zlib';
import { AttributionMaps, aggregateByProjectDay, parseLogFile, tenantOf } from '../lambdas/ingestion/parse';
import { loadAttributionMaps } from '../lambdas/shared/project-registry';

const s3 = new S3Client({});
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TABLE = process.env.AGGREGATES_TABLE!;
const BUCKET = process.env.RAW_LOG_BUCKET!;
const TENANT = process.env.TENANT!;
const DAY = process.env.DAY!;
const EXPECT = process.env.EXPECT_DELTA_INV ? Number(process.env.EXPECT_DELTA_INV) : null;
const APPLY = process.argv.includes('--apply');
const COUNTERS = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'cacheWrite5mTokens', 'cacheWrite1hTokens', 'invocations'] as const;
type Counter = (typeof COUNTERS)[number];

async function listPrefix(prefix: string): Promise<string[]> {
  const keys: string[] = []; let token: string | undefined;
  do {
    const page = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: prefix, ContinuationToken: token }));
    for (const o of page.Contents ?? []) if (o.Key && !o.Key.includes('/data/')) keys.push(o.Key);
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
  return keys;
}

async function main(): Promise<void> {
  for (const [k, v] of Object.entries({ TABLE, BUCKET, TENANT, DAY })) if (!v) { console.error(`${k} is required`); process.exit(2); }
  console.log(`table=${TABLE} tenant=${TENANT} day=${DAY} mode=${APPLY ? 'APPLY' : 'DRY RUN (pass --apply to write)'}`);

  // Marker first: a repaired day is never repaired twice.
  const marker = await ddb.send(new QueryCommand({
    TableName: TABLE, KeyConditionExpression: 'pk = :pk AND sk = :sk',
    ExpressionAttributeValues: { ':pk': 'SYSTEM#REPAIR#projday', ':sk': DAY },
  }));
  if ((marker.Items ?? []).length) { console.log(`already repaired: ${JSON.stringify(marker.Items![0])}`); return; }

  // Truth: raw objects for the day + the next hour (records timestamped late on the day can land in
  // the next hour's object), filtered by record day bucket.
  const [y, m, d] = DAY.split('-');
  const next = new Date(Date.UTC(+y, +m - 1, +d + 1)).toISOString().slice(0, 10).split('-');
  // The account id is the next path segment after the log prefix; one delimiter-listing finds it
  // without walking the bucket (client-sts is not a dependency of the backend).
  const base = process.env.LOG_PREFIX ?? 'model-logs/AWSLogs/';
  const top = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: base, Delimiter: '/' }));
  const acctPrefix = (top.CommonPrefixes ?? [])[0]?.Prefix;
  if (!acctPrefix) { console.error(`no account prefix under ${base}`); process.exit(1); }
  const root = `${acctPrefix}BedrockModelInvocationLogs/${process.env.AWS_REGION ?? 'us-east-1'}/`;
  const keys = [
    ...await listPrefix(`${root}${y}/${m}/${d}/`),
    ...await listPrefix(`${root}${next[0]}/${next[1]}/${next[2]}/00/`),
  ];
  console.log(`${keys.length} raw object(s) to read`);
  let maps: AttributionMaps | undefined;
  try { maps = await loadAttributionMaps(); } catch (e) { console.error('attribution maps unavailable — refusing (truth would be misattributed):', (e as Error).message); process.exit(1); }

  // Fetch with retry (a flaky link resets connections mid-stream) and a small pool: the walk is
  // latency-bound, and a partial read must never silently shrink the truth.
  const fetchText = async (key: string): Promise<string> => {
    for (let attempt = 1; ; attempt += 1) {
      try {
        const body = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
        const raw = Buffer.from(await body.Body!.transformToByteArray());
        return key.endsWith('.gz') ? gunzipSync(raw).toString('utf8') : raw.toString('utf8');
      } catch (e) {
        if (attempt >= 5) throw new Error(`${key}: ${(e as Error).message} after ${attempt} attempts`);
        await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
      }
    }
  };
  const records: ReturnType<typeof parseLogFile> = [];
  let cursor = 0, fetched = 0;
  const worker = async () => {
    while (cursor < keys.length) {
      const key = keys[cursor]; cursor += 1;
      const text = await fetchText(key);
      for (const r of parseLogFile(text)) if (r.timestamp.slice(0, 10) === DAY && tenantOf(r) === TENANT) records.push(r);
      fetched += 1;
      if (fetched % 500 === 0) console.log(`  … ${fetched}/${keys.length} objects read`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(Number(process.env.CONCURRENCY ?? '12') || 12, keys.length) }, worker));
  const truth = new Map<string, Record<Counter, number>>();
  for (const a of aggregateByProjectDay(records, maps).values()) {
    truth.set(`${a.day}#${a.projectId}#${a.modelId}`, {
      inputTokens: a.inputTokens, outputTokens: a.outputTokens, cacheReadTokens: a.cacheReadTokens,
      cacheWriteTokens: a.cacheWriteTokens, cacheWrite5mTokens: a.cacheWrite5mTokens, cacheWrite1hTokens: a.cacheWrite1hTokens,
      invocations: a.invocations,
    });
  }
  const truthInv = [...truth.values()].reduce((s, t) => s + t.invocations, 0);
  console.log(`truth: ${records.length} record(s) → ${truth.size} (project, model) row(s), ${truthInv} invocation(s)`);

  // Current items.
  const cur = await ddb.send(new QueryCommand({
    TableName: TABLE, KeyConditionExpression: 'pk = :pk AND begins_with(sk, :d)',
    ExpressionAttributeValues: { ':pk': `TENANT#${TENANT}#PROJDAY`, ':d': `${DAY}#` },
  }));
  const items = (cur.Items ?? []) as Record<string, unknown>[];
  const n = (it: Record<string, unknown>, k: string) => (typeof it[k] === 'number' ? (it[k] as number) : 0);

  const modelOf = (sk: string) => sk.split('#', 3)[2];
  const projOf = (sk: string) => sk.split('#', 3)[1];
  const models = new Set([...items.map((it) => modelOf(String(it.sk))), ...[...truth.keys()].map(modelOf)]);
  const plan: { sk: string; delta: Record<Counter, number> }[] = [];
  let bad = 0, sumInv = 0;
  for (const model of models) {
    const rows = items.filter((it) => modelOf(String(it.sk)) === model);
    const untaggedItem = rows.find((it) => projOf(String(it.sk)) === 'untagged');
    const untaggedTruth = truth.get(`${DAY}#untagged#${model}`);
    const projRows = rows.filter((it) => projOf(String(it.sk)) !== 'untagged');
    // Project rows whose truth is non-zero are live-attributed (AIP tag etc.), not treatment rows —
    // they must match truth exactly and take no part in the surplus arithmetic.
    for (const pr of projRows) {
      const t = truth.get(String(pr.sk));
      if (t) {
        const diff = COUNTERS.filter((c) => n(pr, c) !== t[c]);
        if (diff.length) { bad += 1; console.log(`  ✗ live row differs from truth: ${String(pr.sk).slice(11)} (${diff.join(',')})`); }
        else console.log(`  = exact     ${String(pr.sk).slice(11)}  inv=${n(pr, 'invocations')}`);
      }
    }
    const moved = projRows.filter((pr) => !truth.has(String(pr.sk)));
    if (!untaggedItem && moved.length === 0) continue;
    const surplus = Object.fromEntries(COUNTERS.map((c) => {
      const item = untaggedItem ? n(untaggedItem, c) : 0;
      const t = untaggedTruth?.[c] ?? 0;
      const movedSum = moved.reduce((acc, pr) => acc + n(pr, c), 0);
      return [c, item - (t - movedSum)];
    })) as Record<Counter, number>;
    const line = `${model.split('/').pop()}  untagged item=${untaggedItem ? n(untaggedItem, 'invocations') : 0} truth=${untaggedTruth?.invocations ?? 0} moved→projects=${moved.reduce((a, pr) => a + n(pr, 'invocations'), 0)}  surplus ${COUNTERS.map((c) => `${c}=${surplus[c]}`).join(' ')}`;
    if (COUNTERS.some((c) => surplus[c] < 0)) { bad += 1; console.log('  ✗ NEGATIVE ', line); }
    else if (COUNTERS.some((c) => surplus[c] > 0)) {
      if (!untaggedItem) { bad += 1; console.log('  ✗ surplus but no untagged row ', line); }
      else { plan.push({ sk: String(untaggedItem.sk), delta: surplus }); console.log('  − repair   ', line); }
    } else console.log('  = exact    ', line);
    sumInv += surplus.invocations;
  }
  console.log(`Σ surplus invocations = ${sumInv}${EXPECT !== null ? ` (expected ${EXPECT})` : ''}; ${plan.length} untagged row(s) to repair; ${bad} problem row(s)`);

  if (bad > 0) { console.error('REFUSING: the treatment-aware arithmetic does not close; see rows above.'); process.exit(1); }
  if (EXPECT !== null && sumInv !== EXPECT) { console.error(`REFUSING: Σ surplus ${sumInv} ≠ expected ${EXPECT}.`); process.exit(1); }
  if (!APPLY || plan.length === 0) { console.log(APPLY ? 'nothing to do.' : 'dry run — no writes performed.'); return; }

  await ddb.send(new PutCommand({
    TableName: TABLE, Item: { pk: 'SYSTEM#REPAIR#projday', sk: DAY, state: 'claimed', claimedAt: new Date().toISOString(), rows: plan.length, deltaInvocations: sumInv },
    ConditionExpression: 'attribute_not_exists(pk)',
  }));
  for (const { sk, delta } of plan) {
    const parts = COUNTERS.filter((c) => delta[c] > 0);
    await ddb.send(new UpdateCommand({
      TableName: TABLE, Key: { pk: `TENANT#${TENANT}#PROJDAY`, sk },
      UpdateExpression: 'ADD ' + parts.map((c) => `${c} :${c}`).join(', '),
      ExpressionAttributeValues: Object.fromEntries(parts.map((c) => [`:${c}`, -delta[c]])),
    }));
  }
  await ddb.send(new UpdateCommand({
    TableName: TABLE, Key: { pk: 'SYSTEM#REPAIR#projday', sk: DAY },
    // `plan` is a DynamoDB reserved word — alias it like `state`.
    UpdateExpression: 'SET #s = :d, doneAt = :t, #p = :p', ExpressionAttributeNames: { '#s': 'state', '#p': 'plan' },
    ExpressionAttributeValues: { ':d': 'done', ':t': new Date().toISOString(), ':p': JSON.stringify(plan) },
  }));
  console.log(`applied: ${plan.length} row(s) corrected by negative ADD; marker written.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
