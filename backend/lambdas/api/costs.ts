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
    const res = await ddb.send(
      new QueryCommand({
        TableName: TABLE,
        KeyConditionExpression: 'pk = :pk',
        ExpressionAttributeValues: { ':pk': `TENANT#${tenantId}#MODEL` },
      }),
    );

    const merged = new Map<string, TokenCounts>();
    for (const i of res.Items ?? []) {
      const rawModelId = String(i.modelId ?? '');
      const modelId = rawModelId.replace(/^(us|eu|ap)\./, '');
      const existing = merged.get(modelId);
      if (existing) {
        existing.inputTokens += Number(i.inputTokens ?? 0);
        existing.outputTokens += Number(i.outputTokens ?? 0);
        existing.cacheReadTokens += Number(i.cacheReadTokens ?? 0);
      } else {
        merged.set(modelId, {
          modelId,
          inputTokens: Number(i.inputTokens ?? 0),
          outputTokens: Number(i.outputTokens ?? 0),
          cacheReadTokens: Number(i.cacheReadTokens ?? 0),
        });
      }
    }
    const items: TokenCounts[] = Array.from(merged.values());

    const summary = summarizeCosts(items);
    return ok({ tenantId, ...summary });
  } catch (err) {
    console.error(err);
    return serverError();
  }
};
