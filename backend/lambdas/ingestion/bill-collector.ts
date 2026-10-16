/**
 * Daily bill collector (feature-40): copies Cost Explorer's Bedrock lines into the aggregates table so
 * the API can show "billed vs what the logs price" without calling Cost Explorer per page view (the API
 * costs $0.01 per request).
 *
 * Why it exists: since 2026-10-06 Bedrock Mantle traffic is billed under the ordinary usage types but
 * never reaches the invocation logs — 63% of Opus 5.5 spend in 10-06 → 10-13 was invisible to every
 * rollup. The bill is the only exact source for that spend.
 *
 * Runs once a day; reads the last LOOKBACK_DAYS days at DAILY granularity (Cost Explorer marks recent
 * days `Estimated` and revises them, so re-reading settles them). Each line is stored as
 *   pk = BILL#DAILY, sk = <day>#<usageType>   { usd, qty, model, kind, route, region, estimated, collectedAt }
 * with PutItem — idempotent. `SYSTEM#BILL` records lastRunAt and the last day read. Lines that do not
 * parse keep kind 'other': a billed line is never dropped.
 *
 * It also computes the other side of the comparison for the same days — what the invocation logs price,
 * summed over every tenant's PROJDAY rows — and stores it as LOGGED#DAILY / <day>#<modelKey>. Tenants are
 * identity ARNs (thousands, one per AgentCore session), so that sum is done here once a day, never by a
 * page view.
 */
import { CostExplorerClient, GetCostAndUsageCommand } from '@aws-sdk/client-cost-explorer';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { BillLine, billLinesFrom } from './bill-parse';
import { computeLoggedByModelDay, storeLoggedByModelDay } from '../shared/logged-estimate';

const ce = new CostExplorerClient({ region: 'us-east-1' }); // Cost Explorer is a us-east-1 endpoint
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TABLE = process.env.AGGREGATES_TABLE!;
const LOOKBACK_DAYS = Math.max(1, Number(process.env.BILL_LOOKBACK_DAYS ?? '4') || 4);
export const BILL_PK = 'BILL#DAILY';
export const SERVICES = ['Amazon Bedrock Service', 'Amazon Bedrock'];

const day = (d: Date) => d.toISOString().slice(0, 10);

/** Read every Bedrock usage-type line for [start, end) — all pages. */
export async function fetchBillLines(start: string, end: string): Promise<BillLine[]> {
  const results: NonNullable<Parameters<typeof billLinesFrom>[0]> = [];
  let token: string | undefined;
  do {
    const res = await ce.send(new GetCostAndUsageCommand({
      TimePeriod: { Start: start, End: end },
      Granularity: 'DAILY',
      Metrics: ['UnblendedCost', 'UsageQuantity'],
      GroupBy: [{ Type: 'DIMENSION', Key: 'USAGE_TYPE' }],
      Filter: { Dimensions: { Key: 'SERVICE', Values: SERVICES } },
      NextPageToken: token,
    }));
    results.push(...(res.ResultsByTime ?? []));
    token = res.NextPageToken;
  } while (token);
  return billLinesFrom(results);
}

export const handler = async (event?: { start?: string; end?: string }): Promise<{ lines: number; days: number; start: string; end: string }> => {
  const today = new Date();
  const end = event?.end ?? day(today); // exclusive
  const start = event?.start ?? day(new Date(today.getTime() - LOOKBACK_DAYS * 86_400_000));
  const lines = await fetchBillLines(start, end);
  const collectedAt = new Date().toISOString();
  for (const l of lines) {
    await ddb.send(new PutCommand({
      TableName: TABLE,
      Item: {
        pk: BILL_PK, sk: `${l.day}#${l.usageType}`,
        day: l.day, usageType: l.usageType, usd: l.usd, qty: l.qty,
        model: l.model, kind: l.kind, route: l.route, region: l.region,
        estimated: l.estimated, collectedAt,
      },
    }));
  }
  const days = new Set(lines.map((l) => l.day)).size;
  // The logged side for the same days (end is exclusive; LOGGED rows are inclusive days).
  const lastDay = day(new Date(Date.parse(end) - 86_400_000));
  const logged = await computeLoggedByModelDay(start, lastDay);
  await storeLoggedByModelDay(logged, collectedAt);
  await ddb.send(new PutCommand({
    TableName: TABLE,
    Item: { pk: 'SYSTEM#BILL', sk: 'collector', lastRunAt: collectedAt, lastStart: start, lastEnd: end, lines: lines.length, days, loggedRows: logged.length },
  }));
  console.log(`bill-collector: ${lines.length} bill line(s) over ${days} day(s), ${logged.length} logged day-model row(s), ${start} → ${end}`);
  return { lines: lines.length, days, start, end };
};
