/**
 * Bedrock Mantle counts (AWS/BedrockMantle), per model per UTC day, PERSISTED by the daily bill collector
 * (feature-46) so the pages never depend on CloudWatch's discovery window: `ListMetrics` lists only
 * metrics with datapoints in the past ~2 weeks, so a model whose Mantle traffic stopped (opus-5-5 after
 * 2026-10-11) vanished from the per-model series while its dollars stayed on the bill — the panel then
 * read "$1,115.68 not logged · Mantle —" (qa F-PR77). `GetMetricData` still returns the data when asked
 * by name; the collector asks by name for every model it has ever seen or that the bill names.
 *
 *   pk = MANTLE#DAILY, sk = <day>#<model>   { day, model, inferences, clientErrors, inputTokens, outputTokens, collectedAt }
 *   pk = MANTLE#FLEET, sk = <day>           { day, inferences }   — the undimensioned series, for the per-model cross-check
 */
import { CloudWatchClient, GetMetricDataCommand, ListMetricsCommand } from '@aws-sdk/client-cloudwatch';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';

const cw = new CloudWatchClient({});
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TABLE = () => process.env.AGGREGATES_TABLE!;
export const MANTLE_NS = 'AWS/BedrockMantle';
export const MANTLE_PK = 'MANTLE#DAILY';
export const MANTLE_FLEET_PK = 'MANTLE#FLEET';

export interface MantleDay { day: string; model: string; inferences: number; clientErrors: number; inputTokens: number; outputTokens: number }
export interface MantleCounts { inferences: number; clientErrors: number; inputTokens: number; outputTokens: number }
export interface MantleRead { perModel: Map<string, MantleCounts>; fleetInferences: number; clientErrors: number; daysStored: string[] }

const METRICS = ['Inferences', 'InferenceClientErrors', 'TotalInputTokens', 'TotalOutputTokens'] as const;
const FIELDS = ['inferences', 'clientErrors', 'inputTokens', 'outputTokens'] as const;
const dayOf = (d: Date) => d.toISOString().slice(0, 10);

/** Model dimension values CloudWatch will list — only those with datapoints in the past ~2 weeks. */
export async function listRecentMantleModels(): Promise<string[]> {
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
  return [...models];
}

/**
 * Which models to ask CloudWatch about: what it lists now ∪ what we have stored before ∪ what the bill
 * names in the window. A bill-line `model` under the current usage-type scheme IS the Mantle `Model`
 * dimension value (`anthropic.claude-opus-5-5`, `openai.gpt-6-luna`); legacy names (`Claude4.6Sonnet`)
 * and non-token lines are filtered by shape.
 */
export function mantleModelsToQuery(listed: Iterable<string>, stored: Iterable<string>, billModels: Iterable<string>): string[] {
  const out = new Set<string>();
  for (const m of listed) out.add(m);
  for (const m of stored) out.add(m);
  for (const m of billModels) if (/^[a-z0-9-]+\.[a-z0-9.-]+$/.test(m) && !m.includes('-mantle-')) out.add(m);
  return [...out].sort();
}

/** Per-day, per-model sums plus the per-day fleet series for [fromDay, toDay] (inclusive UTC days). */
export async function fetchMantleDaily(models: string[], fromDay: string, toDay: string): Promise<{ rows: MantleDay[]; fleet: Map<string, number> }> {
  const start = new Date(`${fromDay}T00:00:00Z`), end = new Date(new Date(`${toDay}T00:00:00Z`).getTime() + 86_400_000);
  type Q = { Id: string; ReturnData: boolean; MetricStat: { Metric: { Namespace: string; MetricName: string; Dimensions?: { Name: string; Value: string }[] }; Period: number; Stat: string } };
  const queries: Q[] = models.flatMap((model, i) => METRICS.map((metricName, j) => ({
    Id: `m${i}_${j}`, ReturnData: true,
    MetricStat: { Metric: { Namespace: MANTLE_NS, MetricName: metricName, Dimensions: [{ Name: 'Model', Value: model }] }, Period: 86_400, Stat: 'Sum' },
  })));
  queries.push({ Id: 'fleet', ReturnData: true, MetricStat: { Metric: { Namespace: MANTLE_NS, MetricName: 'Inferences' }, Period: 86_400, Stat: 'Sum' } });
  const byKey = new Map<string, MantleDay>();
  const fleet = new Map<string, number>();
  for (let s = 0; s < queries.length; s += 500) {
    let token: string | undefined;
    do {
      const res = await cw.send(new GetMetricDataCommand({ MetricDataQueries: queries.slice(s, s + 500), StartTime: start, EndTime: end, NextToken: token }));
      for (const r of res.MetricDataResults ?? []) {
        const ts = r.Timestamps ?? [], vs = r.Values ?? [];
        for (let k = 0; k < vs.length; k += 1) {
          const day = dayOf(new Date(ts[k]));
          if (r.Id === 'fleet') { fleet.set(day, (fleet.get(day) ?? 0) + vs[k]); continue; }
          const m = r.Id?.match(/^m(\d+)_(\d+)$/); if (!m) continue;
          const model = models[Number(m[1])]; const key = `${day}#${model}`;
          const row = byKey.get(key) ?? { day, model, inferences: 0, clientErrors: 0, inputTokens: 0, outputTokens: 0 };
          row[FIELDS[Number(m[2])]] += vs[k]; byKey.set(key, row);
        }
      }
      token = res.NextToken;
    } while (token);
  }
  return { rows: [...byKey.values()].filter((r) => r.inferences + r.clientErrors + r.inputTokens + r.outputTokens > 0), fleet };
}

/** SET semantics — a re-run for the same days overwrites with the recomputed truth. */
export async function storeMantleDaily(rows: MantleDay[], fleet: Map<string, number>, collectedAt: string): Promise<void> {
  for (const r of rows) await ddb.send(new PutCommand({ TableName: TABLE(), Item: { pk: MANTLE_PK, sk: `${r.day}#${r.model}`, ...r, collectedAt } }));
  for (const [day, inferences] of fleet) await ddb.send(new PutCommand({ TableName: TABLE(), Item: { pk: MANTLE_FLEET_PK, sk: day, day, inferences, collectedAt } }));
}

async function queryAll(pk: string, fromSk: string, toSk: string): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  let start: Record<string, unknown> | undefined;
  do {
    const res = await ddb.send(new QueryCommand({
      TableName: TABLE(), KeyConditionExpression: 'pk = :pk AND sk BETWEEN :a AND :b',
      ExpressionAttributeValues: { ':pk': pk, ':a': fromSk, ':b': toSk }, ExclusiveStartKey: start,
    }));
    out.push(...((res.Items ?? []) as Record<string, unknown>[]));
    start = res.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (start);
  return out;
}

/** Every model ever stored (the persisted inventory ListMetrics forgets). */
export async function storedMantleModels(): Promise<string[]> {
  const items = await queryAll(MANTLE_PK, '0000-00-00#', '9999-99-99#￿');
  return [...new Set(items.map((it) => String(it.model)))];
}

/** Stored rows and fleet for [fromDay, toDay]. */
export async function readMantleDailyStored(fromDay: string, toDay: string): Promise<{ rows: MantleDay[]; fleet: Map<string, number> }> {
  const [items, fleetItems] = await Promise.all([queryAll(MANTLE_PK, `${fromDay}#`, `${toDay}#￿`), queryAll(MANTLE_FLEET_PK, fromDay, toDay)]);
  const rows = items.map((it) => ({ day: String(it.day), model: String(it.model), inferences: Number(it.inferences ?? 0), clientErrors: Number(it.clientErrors ?? 0), inputTokens: Number(it.inputTokens ?? 0), outputTokens: Number(it.outputTokens ?? 0) }));
  return { rows, fleet: new Map(fleetItems.map((it) => [String(it.day), Number(it.inferences ?? 0)])) };
}

/** Fold day rows into the per-model totals the bill block and the latency page consume. */
export function foldMantle(rows: MantleDay[], fleet: Map<string, number>): MantleRead {
  const perModel = new Map<string, MantleCounts>();
  const days = new Set<string>();
  for (const r of rows) {
    days.add(r.day);
    const c = perModel.get(r.model) ?? { inferences: 0, clientErrors: 0, inputTokens: 0, outputTokens: 0 };
    c.inferences += r.inferences; c.clientErrors += r.clientErrors; c.inputTokens += r.inputTokens; c.outputTokens += r.outputTokens;
    perModel.set(r.model, c);
  }
  for (const d of fleet.keys()) days.add(d);
  let fleetInferences = 0; for (const v of fleet.values()) fleetInferences += v;
  return { perModel, fleetInferences, clientErrors: [...perModel.values()].reduce((a, c) => a + c.clientErrors, 0), daysStored: [...days].sort() };
}

/**
 * Mantle counts for [fromDay, toDay]: the stored days, plus a live read (recent models only — that is all
 * ListMetrics can list, and all the un-stored tail can contain) for days after the last stored day, so
 * today's calls show without waiting for tomorrow's collector run.
 */
export async function readMantle(fromDay: string, toDay: string): Promise<MantleRead & { storedThrough: string | null }> {
  const stored = await readMantleDailyStored(fromDay, toDay);
  const storedThrough = stored.fleet.size || stored.rows.length ? [...new Set([...stored.rows.map((r) => r.day), ...stored.fleet.keys()])].sort().at(-1)! : null;
  const liveFrom = storedThrough ? dayOf(new Date(Date.parse(storedThrough) + 86_400_000)) : fromDay;
  let rows = stored.rows, fleet = stored.fleet;
  if (liveFrom <= toDay) {
    const live = await fetchMantleDaily(await listRecentMantleModels(), liveFrom, toDay);
    rows = [...rows, ...live.rows]; fleet = new Map([...fleet, ...live.fleet]);
  }
  return { ...foldMantle(rows, fleet), storedThrough };
}
