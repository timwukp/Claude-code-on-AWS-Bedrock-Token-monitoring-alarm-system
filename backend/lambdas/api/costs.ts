import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ok, serverError } from '../shared/response';
import { getTenantId } from '../shared/tenant';
import { cacheWriteOf, summarizeCosts, normalizeModelId, TokenCounts } from './cost-calc';
import { profileModelMap } from '../shared/project-registry';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TABLE = process.env.AGGREGATES_TABLE!;

/**
 * GET /v1/costs — estimated spend per model for the tenant, derived from token aggregates and a
 * per-model rate card (see cost-calc.ts). Also reports prompt-cache savings: how much the 0.1×
 * cache-read rate saved versus charging those tokens at the full input price. Cost logic is
 * unit-tested in cost-calc.test.ts.
 */
export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const tenantId = getTenantId(event);
    const modelId = event.pathParameters?.modelId;

    const res = await ddb.send(
      new QueryCommand({
        TableName: TABLE,
        // Aggregator writes pk=TENANT#<tenant>#MODEL with sk=<modelId> (see ingestion/aggregator.ts).
        KeyConditionExpression: 'pk = :pk',
        ExpressionAttributeValues: { ':pk': `TENANT#${tenantId}#MODEL` },
      }),
    );

    // Normalization, duplicate-merging (bare id vs inference-profile ARN), and zero-usage
    // filtering all live in summarizeCosts — keep raw rows here.
    // Rows keyed by an inference-profile ARN resolve to their model here (qa F-PR69-004), the way the
    // aggregator resolves them at ingest since feature-36; an unreadable cache leaves ids as stored.
    const profiles = await profileModelMap();
    // Rows may store the bare profile id while the map is keyed by full ARN (or vice versa): also match on the id suffix.
    const byProfileId = new Map<string, string>();
    profiles.forEach((v, k) => byProfileId.set(String(k).split('/').pop()!.toLowerCase(), v));
    const resolveModel = (raw: string) => profiles.get(raw) ?? byProfileId.get(raw.split('/').pop()!.toLowerCase()) ?? raw;
    // qa F-PR69-006: rows whose token counters are all zero must not be listed or counted in
    // 'Models used'. Check every numeric counter (input/output/cache-read and every
    // cache-write field from cacheWriteOf), so a row with only cache-write usage is still kept.
    const hasUsage = (t: TokenCounts) =>
      Object.entries(t).some(([k, v]) => k !== 'modelId' && Number(v) > 0);
    const items: TokenCounts[] = (res.Items ?? []).map((i): TokenCounts => ({
      modelId: resolveModel(String(i.modelId ?? i.sk ?? '')),
      inputTokens: Number(i.inputTokens ?? 0),
      outputTokens: Number(i.outputTokens ?? 0),
      cacheReadTokens: Number(i.cacheReadTokens ?? 0),
      ...cacheWriteOf(i),
    })).filter(hasUsage);

    if (modelId) {
      const match = items.find((i) => normalizeModelId(i.modelId) === normalizeModelId(modelId));
      if (!match) return ok({ tenantId, modelId, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalCost: 0, cacheSavings: 0 });
      const summary = summarizeCosts([match]);
      return ok({ tenantId, modelId, ...summary });
    }

    const summary = summarizeCosts(items);
    return ok({ tenantId, ...summary });
  } catch (err) {
    console.error(err);
    return serverError();
  }
};
