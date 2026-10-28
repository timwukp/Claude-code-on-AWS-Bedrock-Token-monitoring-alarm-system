/**
 * Account-wide "what the logs price" per model key per day (feature-40), computed from every tenant's
 * PROJDAY rows with the same rate card the pages use. Tenants are identity ARNs, and every AgentCore
 * session is its own assumed-role ARN, so there are thousands of them: this is run ONCE A DAY by the bill
 * collector for the days the bill covers and stored as LOGGED#DAILY / <day>#<modelKey> — never per page
 * view. Queries run with bounded concurrency; a tenant with no rows in the range costs one empty Query.
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { billModelKey } from '../api/bill-calc';
import { cacheWriteOf, computeModelCost } from '../api/cost-calc';
import { profileModelMap } from './project-registry';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TABLE = () => process.env.AGGREGATES_TABLE!;
export const LOGGED_PK = 'LOGGED#DAILY';

export interface LoggedDay { day: string; model: string; usd: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; invocations: number }

/**
 * Every tenant the aggregator has written rollups for: one `SYSTEM#TENANT / <tenant>` item each
 * (feature-47 — the single-item `SYSTEM#TENANTS/all` list reached ~341 KB of DynamoDB's 400 KB ceiling).
 * Falls back to the legacy item until `scripts/seed-tenant-index.ts --apply` has migrated it.
 */
export async function listTenants(): Promise<string[]> {
  const out: string[] = [];
  let start: Record<string, unknown> | undefined;
  do {
    const res = await ddb.send(new QueryCommand({
      TableName: TABLE(), KeyConditionExpression: 'pk = :pk', ExpressionAttributeValues: { ':pk': 'SYSTEM#TENANT' },
      ProjectionExpression: 'sk', ExclusiveStartKey: start,
    }));
    for (const it of (res.Items ?? []) as Record<string, unknown>[]) out.push(String(it.sk));
    start = res.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (start);
  if (out.length) return out;
  const legacy = await ddb.send(new GetCommand({ TableName: TABLE(), Key: { pk: 'SYSTEM#TENANTS', sk: 'all' } }));
  const t = legacy.Item?.tenants;
  return Array.isArray(t) ? t.map(String) : [];
}

/** Sum and price every tenant's PROJDAY rows for [fromDay, toDay] into per-day, per-model-key totals. */
export async function computeLoggedByModelDay(fromDay: string, toDay: string, concurrency = 25, onlyTenants?: string[]): Promise<LoggedDay[]> {
  const [tenants, profiles] = await Promise.all([onlyTenants ?? listTenants(), profileModelMap()]);
  const acc = new Map<string, LoggedDay>();
  let next = 0;
  const worker = async () => {
    while (next < tenants.length) {
      const tenant = tenants[next]; next += 1;
      let start: Record<string, unknown> | undefined;
      do {
        const res = await ddb.send(new QueryCommand({
          TableName: TABLE(), KeyConditionExpression: 'pk = :pk AND sk BETWEEN :a AND :b',
          ExpressionAttributeValues: { ':pk': `TENANT#${tenant}#PROJDAY`, ':a': fromDay, ':b': `${toDay}#￿` }, ExclusiveStartKey: start,
        }));
        for (const it of (res.Items ?? []) as Record<string, unknown>[]) {
          const raw = String(it.modelId ?? ''); const modelId = profiles.get(raw) ?? raw;
          const counts = { inputTokens: Number(it.inputTokens ?? 0), outputTokens: Number(it.outputTokens ?? 0), cacheReadTokens: Number(it.cacheReadTokens ?? 0), ...cacheWriteOf(it) };
          const usd = computeModelCost({ modelId, ...counts }).estimatedUsd;
          const day = String(it.day ?? ''); const model = billModelKey(modelId); const k = `${day}#${model}`;
          const e = acc.get(k) ?? { day, model, usd: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, invocations: 0 };
          e.usd += usd; e.inputTokens += counts.inputTokens; e.outputTokens += counts.outputTokens; e.cacheReadTokens += counts.cacheReadTokens;
          e.cacheWriteTokens += counts.cacheWriteTokens; e.invocations += Number(it.invocations ?? 0);
          acc.set(k, e);
        }
        start = res.LastEvaluatedKey as Record<string, unknown> | undefined;
      } while (start);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, tenants.length)) }, worker));
  return [...acc.values()];
}

/** Store the day totals (SET — idempotent; a re-run for the same days overwrites with the recomputed truth). */
export async function storeLoggedByModelDay(rows: LoggedDay[], computedAt: string): Promise<void> {
  for (const r of rows) {
    await ddb.send(new PutCommand({ TableName: TABLE(), Item: { pk: LOGGED_PK, sk: `${r.day}#${r.model}`, ...r, usd: Math.round(r.usd * 1e6) / 1e6, computedAt } }));
  }
}

/** Read the stored day totals for [fromDay, toDay] as the map `buildBill` consumes: model key → day → USD. */
export async function readLoggedByModelDay(fromDay: string, toDay: string): Promise<Map<string, Map<string, number>>> {
  const out = new Map<string, Map<string, number>>();
  let start: Record<string, unknown> | undefined;
  do {
    const res = await ddb.send(new QueryCommand({
      TableName: TABLE(), KeyConditionExpression: 'pk = :pk AND sk BETWEEN :a AND :b',
      ExpressionAttributeValues: { ':pk': LOGGED_PK, ':a': `${fromDay}#`, ':b': `${toDay}#￿` }, ExclusiveStartKey: start,
    }));
    for (const it of (res.Items ?? []) as Record<string, unknown>[]) {
      const model = String(it.model), day = String(it.day);
      const perDay = out.get(model) ?? new Map<string, number>();
      perDay.set(day, (perDay.get(day) ?? 0) + Number(it.usd ?? 0)); out.set(model, perDay);
    }
    start = res.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (start);
  return out;
}
