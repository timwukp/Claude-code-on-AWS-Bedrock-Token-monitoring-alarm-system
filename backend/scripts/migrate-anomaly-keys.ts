/**
 * One-off migration: move anomaly items off the key shape no reader can query.
 *
 * `anomaly-response` wrote `pk = TENANT#<t>#ANOMALY` with a bare `<detectedAt>#<type>#<ip>` sort key.
 * `api/anomalies.ts` queries `pk = TENANT#<t>` with `begins_with(sk, 'ANOMALY#')`. Neither half
 * matched, so every alert that Lambda ever wrote is present in the table and absent from the feed
 * built to show it — the dev table held 3 such items (2 AccessDenied, 1 OffHoursUsage) and nothing
 * readable at all. `shared/anomaly-key.ts` fixes new writes; only this fixes the ones already there.
 *
 * Safety, in the style of backfill-projday.ts:
 *  - DRY RUN BY DEFAULT. It prints the rewrite plan and exits; `--apply` is required to write.
 *  - The new item is Put under `attribute_not_exists(pk)`, so a second run cannot clobber a migrated
 *    item, and an item migrated by hand is left alone.
 *  - The old item is deleted only after its replacement is confirmed written. A crash in between
 *    leaves a duplicate, which the next run reports and cleans — never a lost alert.
 *  - Items already on the correct shape are counted and skipped, so this is safe to re-run.
 *  - The key logic it applies is `targetKeys` from shared/anomaly-key, unit-tested there.
 *
 *   npx tsx backend/scripts/migrate-anomaly-keys.ts                  # plan only
 *   ANOMALIES_TABLE=tums-anomalies-dev npx tsx … --apply             # perform it
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, PutCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { AnomalyTableItem, targetKeys } from '../lambdas/shared/anomaly-key';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TABLE = process.env.ANOMALIES_TABLE ?? 'tums-anomalies-dev';
const APPLY = process.argv.includes('--apply');

async function main(): Promise<void> {
  console.log(`table=${TABLE} mode=${APPLY ? 'APPLY' : 'DRY RUN (pass --apply to write)'}`);

  const items: AnomalyTableItem[] = [];
  let start: Record<string, unknown> | undefined;
  do {
    const page = await ddb.send(new ScanCommand({ TableName: TABLE, ExclusiveStartKey: start }));
    items.push(...((page.Items ?? []) as AnomalyTableItem[]));
    start = page.LastEvaluatedKey;
  } while (start);

  let conforming = 0;
  let migrated = 0;
  let skipped = 0;
  const plan: { from: AnomalyTableItem; to: { pk: string; sk: string } }[] = [];

  for (const item of items) {
    const to = targetKeys(item);
    if (!to) { conforming += 1; continue; }
    plan.push({ from: item, to });
  }

  console.log(`scanned ${items.length} item(s): ${conforming} already readable, ${plan.length} to rewrite`);
  for (const { from, to } of plan) {
    console.log(`  ${from.pk} | ${from.sk}\n    -> ${to.pk} | ${to.sk}`);
  }
  if (!APPLY || plan.length === 0) {
    console.log(APPLY ? 'nothing to do.' : 'dry run — no writes performed.');
    return;
  }

  for (const { from, to } of plan) {
    const { pk: _oldPk, sk: _oldSk, ...rest } = from;
    try {
      await ddb.send(new PutCommand({
        TableName: TABLE,
        Item: { ...rest, ...to },
        // Never overwrite: a migrated or hand-fixed item wins over this rewrite.
        ConditionExpression: 'attribute_not_exists(pk)',
      }));
    } catch (err) {
      if ((err as { name?: string }).name === 'ConditionalCheckFailedException') {
        // The replacement already exists — the legacy row is the leftover, so drop it.
        await ddb.send(new DeleteCommand({ TableName: TABLE, Key: { pk: from.pk, sk: from.sk } }));
        console.log(`  already migrated, removed legacy row: ${from.sk}`);
        skipped += 1;
        continue;
      }
      console.error(`  FAILED, legacy row left in place: ${from.pk} | ${from.sk}`, (err as Error).message);
      continue;
    }
    // Only now is it safe to drop the original.
    await ddb.send(new DeleteCommand({ TableName: TABLE, Key: { pk: from.pk, sk: from.sk } }));
    migrated += 1;
  }

  console.log(`done: ${migrated} migrated, ${skipped} were already migrated, ${conforming} untouched.`);
}

if (require.main === module) {
  main().catch((err) => { console.error(err); process.exit(1); });
}
