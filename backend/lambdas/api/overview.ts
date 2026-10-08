/**
 * Overview API (feature-23) — one read-only Lambda:
 *
 *   GET /v1/overview?window=7|30|90|mtd   spend for the window vs the prior equal period, a daily
 *                                         series, per-model rows and per-project movers
 *
 * Arithmetic in overview-calc.ts (pure). Reads the same PROJDAY rollups and rate card the Cost and
 * Projects pages use, so the three pages reconcile. Registry names are joined for the movers list.
 * Additive to the API surface: nothing existing changes shape.
 */
import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { badRequest, ok, serverError } from '../shared/response';
import { getTenantId } from '../shared/tenant';
import * as registry from '../shared/project-registry';
import { cacheWriteOf } from './cost-calc';
import { ProjdayItem } from './project-calc';
import { WindowKind, buildOverview, windowBounds } from './overview-calc';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const AGGREGATES_TABLE = process.env.AGGREGATES_TABLE;
const KINDS: readonly WindowKind[] = ['7', '30', '90', 'mtd'];

function parseKind(raw: string | undefined): WindowKind | null {
  if (raw == null || raw === '') return '30';
  return (KINDS as readonly string[]).includes(raw) ? (raw as WindowKind) : null;
}

async function queryProjday(tenantId: string, fromDay: string, toDay: string): Promise<ProjdayItem[]> {
  const out: ProjdayItem[] = [];
  let key: Record<string, unknown> | undefined;
  do {
    const res = await ddb.send(new QueryCommand({
      TableName: AGGREGATES_TABLE,
      KeyConditionExpression: 'pk = :pk AND sk BETWEEN :from AND :to',
      ExpressionAttributeValues: { ':pk': `TENANT#${tenantId}#PROJDAY`, ':from': fromDay, ':to': `${toDay}#￿` },
      ExclusiveStartKey: key,
    }));
    for (const it of (res.Items ?? []) as Record<string, unknown>[]) {
      out.push({
        day: String(it.day ?? ''), projectId: String(it.projectId ?? 'untagged'),
        modelId: String(it.modelId ?? ''), inputTokens: Number(it.inputTokens ?? 0),
        outputTokens: Number(it.outputTokens ?? 0), cacheReadTokens: Number(it.cacheReadTokens ?? 0),
        ...cacheWriteOf(it), invocations: Number(it.invocations ?? 0),
      });
    }
    key = res.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (key);
  return out;
}

/**
 * Two different times from SYSTEM#WATERMARK, because they answer two different questions:
 *   `rollupsAsOf`     — the newest log object folded in (the page's "data as of"). It stands still
 *                       while the logs are quiet, which is NOT a stale aggregator;
 *   `rollupsLastRunAt`— when the aggregator last RAN, written on every run since feature-36 even
 *                       when it found nothing new. Null on a table the new build has not run on yet.
 * The two were conflated in qa F-PR68-001 ("16 h stale" on a quiet weekend).
 */
async function rollupWatermark(): Promise<{ rollupsAsOf: string | null; rollupsLastRunAt: string | null }> {
  try {
    const res = await ddb.send(new GetCommand({ TableName: AGGREGATES_TABLE, Key: { pk: 'SYSTEM#WATERMARK', sk: 'aggregator' } }));
    const ms = Number(res.Item?.lastModified);
    const ran = res.Item?.lastRunAt;
    return {
      rollupsAsOf: Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null,
      rollupsLastRunAt: typeof ran === 'string' && !Number.isNaN(Date.parse(ran)) ? ran : null,
    };
  } catch { return { rollupsAsOf: null, rollupsLastRunAt: null }; }
}

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const tenantId = getTenantId(event);
    const kind = parseKind(event.queryStringParameters?.window);
    if (!kind) return badRequest('window must be one of 7, 30, 90, mtd');

    const bounds = windowBounds(new Date(), kind);
    const [items, projects, watermark] = await Promise.all([
      queryProjday(tenantId, bounds.priorFrom, bounds.to),
      registry.listProjects().catch(() => [] as registry.RegistryProject[]),
      rollupWatermark(),
    ]);
    const names = new Map(projects.map((p) => [p.projectId, p.name]));
    const result = buildOverview(items, bounds, names);
    return ok({ tenantId, ...result, ...watermark });
  } catch (err) {
    console.error(err);
    return serverError();
  }
};
