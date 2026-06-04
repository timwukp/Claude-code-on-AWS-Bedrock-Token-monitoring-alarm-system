import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ok, serverError } from '../shared/response';
import { getTenantId } from '../shared/tenant';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TABLE = process.env.AGGREGATES_TABLE!;

/**
 * GET /v1/costs — estimated spend per model for the tenant, derived from token aggregates and a
 * per-model rate card. Rates are illustrative (Claude Sonnet $3/$15 per MTok); keep them in
 * config and reconfirm against official pricing. See docs/MONITORING_APPROACH.md Sources.
 */
/**
 * modelId substring → per-token rate (USD). Prices from the official Anthropic pricing page
 * (per MTok ÷ 1e6); reconfirm and keep current. cacheReadPerToken is the prompt-cache hit rate
 * (0.1× base input). Order matters: more specific keys first.
 */
const RATE_CARD: Array<{ key: string; inPerToken: number; outPerToken: number; cacheReadPerToken: number }> = [
  { key: 'opus-4-8', inPerToken: 0.000005, outPerToken: 0.000025, cacheReadPerToken: 0.0000005 },
  { key: 'opus', inPerToken: 0.000005, outPerToken: 0.000025, cacheReadPerToken: 0.0000005 },
  { key: 'sonnet', inPerToken: 0.000003, outPerToken: 0.000015, cacheReadPerToken: 0.0000003 },
  { key: 'haiku', inPerToken: 0.000001, outPerToken: 0.000005, cacheReadPerToken: 0.0000001 },
];

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

    const byModel = (res.Items ?? []).map((i) => {
      const rate = matchRate(String(i.modelId ?? ''));
      const estimatedUsd =
        (i.inputTokens ?? 0) * rate.inPerToken +
        (i.outputTokens ?? 0) * rate.outPerToken +
        (i.cacheReadTokens ?? 0) * rate.cacheReadPerToken;
      return {
        modelId: i.modelId,
        inputTokens: i.inputTokens,
        outputTokens: i.outputTokens,
        cacheReadTokens: i.cacheReadTokens ?? 0,
        estimatedUsd: Math.round(estimatedUsd * 1e6) / 1e6,
      };
    });

    return ok({ tenantId, byModel, totalEstimatedUsd: byModel.reduce((s, m) => s + m.estimatedUsd, 0) });
  } catch (err) {
    console.error(err);
    return serverError();
  }
};

function matchRate(modelId: string) {
  for (const r of RATE_CARD) if (modelId.includes(r.key)) return r;
  return { inPerToken: 0, outPerToken: 0, cacheReadPerToken: 0 }; // unknown → 0 until configured
}
