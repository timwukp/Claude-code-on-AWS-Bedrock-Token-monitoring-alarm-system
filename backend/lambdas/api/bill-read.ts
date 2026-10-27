/**
 * The three inputs of the bill block (feature-40), fetched for the API readers:
 *   - stored Cost Explorer lines (BILL#DAILY, written by ingestion/bill-collector.ts) + SYSTEM#BILL.lastRunAt;
 *   - the logged estimate per model key per day (LOGGED#DAILY), computed by the same collector over EVERY
 *     tenant's PROJDAY rows — the bill is account-wide, and tenants are thousands of identity ARNs;
 *   - Bedrock Mantle counts from CloudWatch AWS/BedrockMantle, per `Model` series, plus the undimensioned
 *     fleet series as a consistency check.
 * Every fetch degrades to "absent" rather than failing the page: a missing collector, grant or namespace
 * leaves `bill` null and the rest of the response intact.
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { BillBlock, BillLineItem, MantleCounts, billModelKey, buildBill, mantleConsistent } from './bill-calc';
import { computeLoggedByModelDay, readLoggedByModelDay } from '../shared/logged-estimate';
import { readMantle } from '../shared/mantle-metrics';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TABLE = process.env.AGGREGATES_TABLE!;

export async function readBillLines(fromDay: string, toDay: string): Promise<{ lines: BillLineItem[]; asOf: string | null }> {
  const lines: BillLineItem[] = [];
  let start: Record<string, unknown> | undefined;
  do {
    const res = await ddb.send(new QueryCommand({
      TableName: TABLE, KeyConditionExpression: 'pk = :pk AND sk BETWEEN :a AND :b',
      ExpressionAttributeValues: { ':pk': 'BILL#DAILY', ':a': `${fromDay}#`, ':b': `${toDay}#￿` }, ExclusiveStartKey: start,
    }));
    for (const it of (res.Items ?? []) as Record<string, unknown>[]) {
      lines.push({ day: String(it.day), model: String(it.model), kind: String(it.kind), route: String(it.route), usd: Number(it.usd ?? 0), qty: Number(it.qty ?? 0) });
    }
    start = res.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (start);
  const meta = await ddb.send(new GetCommand({ TableName: TABLE, Key: { pk: 'SYSTEM#BILL', sk: 'collector' } }));
  return { lines, asOf: typeof meta.Item?.lastRunAt === 'string' ? meta.Item.lastRunAt : null };
}

/** The logged side, stored by the daily collector (LOGGED#DAILY) — see shared/logged-estimate.ts. */
export { readLoggedByModelDay as loggedEstimateByModelDay } from '../shared/logged-estimate';

/** Mantle counts: stored days from the collector (MANTLE#DAILY) + a live tail for un-stored days (feature-46). */
export { readMantle } from '../shared/mantle-metrics';

/**
 * The whole block for a day window, or null when the collector has never run (no SYSTEM#BILL) — the page
 * then shows nothing rather than an empty comparison. Mantle failures (no grant, no namespace) leave the
 * dollar comparison intact with `mantle: null` on every row.
 */
export async function billBlockFor(fromDay: string, toDay: string, tenantId?: string): Promise<(BillBlock & { mantleInconsistent?: boolean; mantleStoredThrough?: string | null }) | null> {
  const { lines, asOf } = await readBillLines(fromDay, toDay);
  if (!asOf) return null;
  const billedDays = [...new Set(lines.map((l) => l.day))].sort();
  const [logged, mantle, tenantRows] = await Promise.all([
    readLoggedByModelDay(fromDay, toDay),
    readMantle(fromDay, toDay).catch((err) => { console.warn('bill: Mantle counts unavailable', (err as Error).message); return null; }),
    // The viewer's own share, on the same days, so the account-wide figures can be read against the tenant-scoped page (qa F-PR73-001).
    tenantId && billedDays.length
      ? computeLoggedByModelDay(billedDays[0], billedDays[billedDays.length - 1], 1, [tenantId]).catch(() => null)
      : Promise.resolve(null),
  ]);
  const tenantLogged = tenantRows ? new Map<string, number>() : null;
  if (tenantRows && tenantLogged) for (const r of tenantRows) tenantLogged.set(r.day, (tenantLogged.get(r.day) ?? 0) + r.usd);
  const block = buildBill(lines, logged, mantle?.perModel ?? new Map(), { from: fromDay, to: toDay }, asOf, tenantLogged);
  const out: BillBlock & { mantleInconsistent?: boolean; mantleStoredThrough?: string | null } = { ...block, mantleStoredThrough: mantle?.storedThrough ?? null };
  if (mantle && !mantleConsistent(mantle.perModel, mantle.fleetInferences)) out.mantleInconsistent = true;
  return out;
}
