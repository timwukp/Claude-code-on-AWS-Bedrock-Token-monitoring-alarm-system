import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ok, serverError } from '../shared/response';
import { getTenantId } from '../shared/tenant';
import { summarizeCosts, normalizeModelId, TokenCounts } from './cost-calc';

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
        KeyConditionExpression: 'pk = :pk AND begins_with(sk, :sk)',
        ExpressionAttributeValues: { ':pk': `TENANT#${tenantId}`, ':sk': 'MODEL#' },
      }),
    );

    // Normalization, duplicate-merging (bare id vs inference-profile ARN), and zero-usage
    // filtering all live in summarizeCosts — keep raw rows here.
    const items: TokenCounts[] = (res.Items ?? []).map((i) => ({
      modelId: String(i.modelId ?? ''),
      inputTokens: Number(i.inputTokens ?? 0),
      outputTokens: Number(i.outputTokens ?? 0),
      cacheReadTokens: Number(i.cacheReadTokens ?? 0),
    }));

    if (modelId) {
      const match = items.find((i) => normalizeModelId(i.modelId) === normalizeModelId(modelId));
      if (!match) return ok({ tenantId, modelId, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, totalCost: 0, cacheSavings: 0 });
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
