/**
 * One-time seed of SYSTEM#TENANTS (feature-40). The aggregator maintains the index from the tenants it
 * sees on each run, so on first deploy the index holds only the last few minutes of traffic — and the
 * "billed vs logged" readers, which sum every tenant's PROJDAY rows, under-count the logged side for
 * every tenant not yet seen (observed live: sonnet-5-5 showed $0 logged against 1,500 logged calls).
 * This walks the table's partition keys once and merges every TENANT#…#PROJDAY tenant into the index.
 *
 *   AGGREGATES_TABLE=tums-aggregates-dev AWS_REGION=us-east-1 npx tsx scripts/seed-tenant-index.ts [--apply]
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';

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
  const cur = await ddb.send(new GetCommand({ TableName: TABLE, Key: { pk: 'SYSTEM#TENANTS', sk: 'all' } }));
  const have: string[] = Array.isArray(cur.Item?.tenants) ? cur.Item!.tenants : [];
  const merged = [...new Set([...have, ...found])].sort();
  console.log(`index has ${have.length} tenant(s); table has ${found.size}; merged ${merged.length}; new: ${merged.length - have.length}`);
  for (const t of merged) if (!have.includes(t)) console.log('  +', t.replace(/[0-9]{12}/g, '<ACCT>'));
  if (!APPLY) { console.log('dry run — pass --apply to write'); return; }
  await ddb.send(new PutCommand({ TableName: TABLE, Item: { pk: 'SYSTEM#TENANTS', sk: 'all', tenants: merged, updatedAt: new Date().toISOString(), seededBy: 'scripts/seed-tenant-index.ts' } }));
  console.log('written');
})().catch((e) => { console.error(e); process.exit(1); });
