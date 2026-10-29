/**
 * Tenant index seed + migration. feature-40 seeded a single SYSTEM#TENANTS/all list; feature-47 moved to one
 * SYSTEM#TENANT/<tenant> item each (the list reached ~341 KB of the 400 KB ceiling). This script scans the table's
 * PROJDAY partitions, unions them with the legacy list, writes one item per tenant, and deletes the legacy item.
 * The aggregator maintains the index from the tenants it
 * sees on each run, so on first deploy the index holds only the last few minutes of traffic — and the
 * "billed vs logged" readers, which sum every tenant's PROJDAY rows, under-count the logged side for
 * every tenant not yet seen (observed live: sonnet-5-5 showed $0 logged against 1,500 logged calls).
 * This walks the table's partition keys once and merges every TENANT#…#PROJDAY tenant into the index.
 *
 *   AGGREGATES_TABLE=tums-aggregates-dev AWS_REGION=us-east-1 npx tsx scripts/seed-tenant-index.ts [--apply]
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DeleteCommand, DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TABLE = process.env.AGGREGATES_TABLE!;
const APPLY = process.argv.includes('--apply');

(async () => {
  const found = new Set<string>();
  let start: Record<string, unknown> | undefined;
  do {
    const page = await ddb.send(new ScanCommand({
      TableName: TABLE, ProjectionExpression: 'pk', ExclusiveStartKey: start,
      FilterExpression: 'begins_with(pk, :t) AND contains(pk, :p)', ExpressionAttributeValues: { ':t': 'TENANT#', ':p': '#PROJDAY' },
    }));
    for (const it of page.Items ?? []) found.add(String(it.pk).slice('TENANT#'.length, -'#PROJDAY'.length));
    start = page.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (start);
  const legacy = await ddb.send(new GetCommand({ TableName: TABLE, Key: { pk: 'SYSTEM#TENANTS', sk: 'all' } }));
  const have: string[] = Array.isArray(legacy.Item?.tenants) ? legacy.Item!.tenants : [];
  const existing = new Set<string>();
  start = undefined;
  do {
    const page = await ddb.send(new QueryCommand({ TableName: TABLE, KeyConditionExpression: 'pk = :pk', ExpressionAttributeValues: { ':pk': 'SYSTEM#TENANT' }, ProjectionExpression: 'sk', ExclusiveStartKey: start }));
    for (const it of page.Items ?? []) existing.add(String(it.sk));
    start = page.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (start);
  const all = [...new Set([...have, ...found])].sort();
  const toWrite = all.filter((t) => !existing.has(t));
  console.log(`legacy list ${have.length} · table partitions ${found.size} · per-tenant items already ${existing.size} · union ${all.length} · to write ${toWrite.length}`);
  if (!APPLY) { console.log('dry run — pass --apply to write the per-tenant items and delete the legacy list'); return; }
  const now = new Date().toISOString();
  for (const t of toWrite) await ddb.send(new PutCommand({ TableName: TABLE, Item: { pk: 'SYSTEM#TENANT', sk: t, tenant: t, lastSeenAt: now, seededBy: 'scripts/seed-tenant-index.ts' } }));
  if (legacy.Item) await ddb.send(new DeleteCommand({ TableName: TABLE, Key: { pk: 'SYSTEM#TENANTS', sk: 'all' } }));
  console.log(`written ${toWrite.length} item(s); legacy SYSTEM#TENANTS/all ${legacy.Item ? 'deleted' : 'absent'}`);
})().catch((e) => { console.error(e); process.exit(1); });
