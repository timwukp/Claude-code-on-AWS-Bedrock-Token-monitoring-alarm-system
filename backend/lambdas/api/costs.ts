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
        KeyConditionExpression: 'pk = :pk AND begins_with(sk, :sk)',
        ExpressionAttributeValues: { ':pk': `TENANT#${tenantId}`, ':sk': 'MODEL#' },
      }),
    );

    // The same model can be metered under two identities: a bare model id and a full
    // inference-profile ARN (arn:...:inference-profile/<id>). Normalize to the bare id so
    // the dedup below merges them into one row instead of showing duplicates.
    const normalizeModelId = (id: string) => id.replace(/^arn:[^/]+\/(?=.)/, '');
    const items: TokenCounts[] = (res.Items ?? []).map((i) => ({
      modelId: normalizeModelId(String(i.modelId ?? '')),
      inputTokens: Number(i.inputTokens ?? 0),
      outputTokens: Number(i.outputTokens ?? 0),
      cacheReadTokens: Number(i.cacheReadTokens ?? 0),
    }));

    const deduped = new Map<string, TokenCounts>();
    for (const item of items) {
      const existing = deduped.get(item.modelId);
      if (existing) {
        existing.inputTokens = (existing.inputTokens ?? 0) + (item.inputTokens ?? 0);
        existing.outputTokens = (existing.outputTokens ?? 0) + (item.outputTokens ?? 0);
        existing.cacheReadTokens = (existing.cacheReadTokens ?? 0) + (item.cacheReadTokens ?? 0);
      } else {
        deduped.set(item.modelId, { ...item });
      }
    }
    const mergedItems = Array.from(deduped.values());

    if (modelId) {
      const match = mergedItems.find((i) => i.modelId === modelId);
      if (!match) return ok({ tenantId, modelId, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, totalCost: 0, cacheSavings: 0 });
      const summary = summarizeCosts([match]);
      return ok({ tenantId, modelId, ...summary });
    }

    const summary = summarizeCosts(mergedItems);
    return ok({ tenantId, ...summary });
  } catch (err) {
    console.error(err);
    return serverError();
  }
};
