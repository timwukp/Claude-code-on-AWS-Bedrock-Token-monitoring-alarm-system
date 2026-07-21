import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ok, serverError } from '../shared/response';
import { getTenantId } from '../shared/tenant';
import { summarizeCosts, TokenCounts } from './cost-calc';

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
        KeyConditionExpression: 'pk = :pk',
        ExpressionAttributeValues: { ':pk': `TENANT#${tenantId}#MODEL` },
      }),
    );

    const items: TokenCounts[] = (res.Items ?? []).map((i) => ({
      modelId: String(i.modelId ?? ''),
      inputTokens: Number(i.inputTokens ?? 0),
      outputTokens: Number(i.outputTokens ?? 0),
      cacheReadTokens: Number(i.cacheReadTokens ?? 0),
    }));

    if (modelId) {
      const match = items.find((i) => i.modelId === modelId);
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
