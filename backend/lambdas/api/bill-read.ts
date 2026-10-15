/**
 * The three inputs of the bill block (feature-40), fetched for the API readers:
 *   - stored Cost Explorer lines (BILL#DAILY, written by ingestion/bill-collector.ts) + SYSTEM#BILL.lastRunAt;
 *   - the logged estimate per model key per day, over EVERY tenant's PROJDAY rows (the bill is account-wide;
 *     tenants come from SYSTEM#TENANTS, which the aggregator maintains);
 *   - Bedrock Mantle counts from CloudWatch AWS/BedrockMantle, per `Model` series, plus the undimensioned
 *     fleet series as a consistency check.
 * Every fetch degrades to "absent" rather than failing the page: a missing collector, grant or namespace
 * leaves `bill` null and the rest of the response intact.
 */
import { CloudWatchClient, GetMetricDataCommand, ListMetricsCommand } from '@aws-sdk/client-cloudwatch';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { BillBlock, BillLineItem, MantleCounts, billModelKey, buildBill, mantleConsistent } from './bill-calc';
import { cacheWriteOf, computeModelCost } from './cost-calc';
import { profileModelMap } from '../shared/project-registry';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const cw = new CloudWatchClient({});
const TABLE = process.env.AGGREGATES_TABLE!;
export const MANTLE_NS = 'AWS/BedrockMantle';

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

/** Every tenant the aggregator has written rollups for (SYSTEM#TENANTS, maintained per run). */
export async function listTenants(): Promise<string[]> {
  const res = await ddb.send(new GetCommand({ TableName: TABLE, Key: { pk: 'SYSTEM#TENANTS', sk: 'all' } }));
  const t = res.Item?.tenants;
  return Array.isArray(t) ? t.map(String) : t instanceof Set ? [...t].map(String) : [];
}

/** Logged estimate per model key per day across all tenants: the same pricing the pages use. */
export async function loggedEstimateByModelDay(fromDay: string, toDay: string): Promise<Map<string, Map<string, number>>> {
  const out = new Map<string, Map<string, number>>();
  const [tenants, profiles] = await Promise.all([listTenants(), profileModelMap()]);
  for (const tenant of tenants) {
    let start: Record<string, unknown> | undefined;
    do {
      const res = await ddb.send(new QueryCommand({
        TableName: TABLE, KeyConditionExpression: 'pk = :pk AND sk BETWEEN :a AND :b',
        ExpressionAttributeValues: { ':pk': `TENANT#${tenant}#PROJDAY`, ':a': fromDay, ':b': `${toDay}#￿` }, ExclusiveStartKey: start,
      }));
      for (const it of (res.Items ?? []) as Record<string, unknown>[]) {
        const raw = String(it.modelId ?? '');
        const modelId = profiles.get(raw) ?? raw;
        const usd = computeModelCost({
          modelId, inputTokens: Number(it.inputTokens ?? 0), outputTokens: Number(it.outputTokens ?? 0),
          cacheReadTokens: Number(it.cacheReadTokens ?? 0), ...cacheWriteOf(it),
        }).estimatedUsd;
        const key = billModelKey(modelId);
        const perDay = out.get(key) ?? new Map<string, number>();
        perDay.set(String(it.day), (perDay.get(String(it.day)) ?? 0) + usd);
        out.set(key, perDay);
      }
      start = res.LastEvaluatedKey as Record<string, unknown> | undefined;
    } while (start);
  }
  return out;
}

/** Mantle counts per Model over [from, to] (inclusive days), and the fleet inferences for the consistency check. */
export async function readMantle(fromDay: string, toDay: string): Promise<{ perModel: Map<string, MantleCounts>; fleetInferences: number; clientErrors: number }> {
  const models = new Set<string>();
  let next: string | undefined;
  do {
    const res = await cw.send(new ListMetricsCommand({ Namespace: MANTLE_NS, MetricName: 'Inferences', NextToken: next }));
    for (const m of res.Metrics ?? []) {
      const dims = m.Dimensions ?? [];
      if (dims.length === 1 && dims[0].Name === 'Model' && dims[0].Value) models.add(dims[0].Value);
    }
    next = res.NextToken;
  } while (next);
  const start = new Date(`${fromDay}T00:00:00Z`), end = new Date(new Date(`${toDay}T00:00:00Z`).getTime() + 86_400_000);
  const period = 86_400; // daily datapoints, aligned to the UTC midnights the days are defined by; summed below
  const list = [...models];
  const metrics = ['Inferences', 'InferenceClientErrors', 'TotalInputTokens', 'TotalOutputTokens'] as const;
  type Q = { Id: string; ReturnData: boolean; MetricStat: { Metric: { Namespace: string; MetricName: string; Dimensions?: { Name: string; Value: string }[] }; Period: number; Stat: string } };
  const queries: Q[] = list.flatMap((model, i) => metrics.map((metricName, j) => ({
    Id: `m${i}_${j}`, ReturnData: true,
    MetricStat: { Metric: { Namespace: MANTLE_NS, MetricName: metricName, Dimensions: [{ Name: 'Model', Value: model }] }, Period: period, Stat: 'Sum' },
  })));
  queries.push({ Id: 'fleet', ReturnData: true, MetricStat: { Metric: { Namespace: MANTLE_NS, MetricName: 'Inferences' }, Period: period, Stat: 'Sum' } });
  const perModel = new Map<string, MantleCounts>(list.map((m) => [m, { inferences: 0, clientErrors: 0, inputTokens: 0, outputTokens: 0 }]));
  let fleetInferences = 0;
  for (let s = 0; s < queries.length; s += 500) {
    let token: string | undefined;
    do {
      const res = await cw.send(new GetMetricDataCommand({ MetricDataQueries: queries.slice(s, s + 500), StartTime: start, EndTime: end, NextToken: token }));
      for (const r of res.MetricDataResults ?? []) {
        const sum = (r.Values ?? []).reduce((a, b) => a + b, 0);
        if (r.Id === 'fleet') { fleetInferences += sum; continue; }
        const m = r.Id?.match(/^m(\d+)_(\d+)$/); if (!m) continue;
        const c = perModel.get(list[Number(m[1])]); if (!c) continue;
        const field = (['inferences', 'clientErrors', 'inputTokens', 'outputTokens'] as const)[Number(m[2])];
        c[field] += sum;
      }
      token = res.NextToken;
    } while (token);
  }
  const clientErrors = [...perModel.values()].reduce((a, c) => a + c.clientErrors, 0);
  return { perModel, fleetInferences, clientErrors };
}

/**
 * The whole block for a day window, or null when the collector has never run (no SYSTEM#BILL) — the page
 * then shows nothing rather than an empty comparison. Mantle failures (no grant, no namespace) leave the
 * dollar comparison intact with `mantle: null` on every row.
 */
export async function billBlockFor(fromDay: string, toDay: string): Promise<(BillBlock & { mantleInconsistent?: boolean }) | null> {
  const { lines, asOf } = await readBillLines(fromDay, toDay);
  if (!asOf) return null;
  const [logged, mantle] = await Promise.all([
    loggedEstimateByModelDay(fromDay, toDay),
    readMantle(fromDay, toDay).catch((err) => { console.warn('bill: Mantle counts unavailable', (err as Error).message); return null; }),
  ]);
  const block = buildBill(lines, logged, mantle?.perModel ?? new Map(), { from: fromDay, to: toDay }, asOf);
  if (mantle && !mantleConsistent(mantle.perModel, mantle.fleetInferences)) return { ...block, mantleInconsistent: true };
  return block;
}
