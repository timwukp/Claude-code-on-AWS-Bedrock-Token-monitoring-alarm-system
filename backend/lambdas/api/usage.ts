import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ok, serverError } from '../shared/response';
import { getTenantId } from '../shared/tenant';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TABLE = process.env.AGGREGATES_TABLE!;

/**
 * GET /v1/usage?from=ISO&to=ISO&granularity=hour|day
 * Returns pre-aggregated token/invocation time series for the caller's tenant (hot read).
 */
export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const tenantId = getTenantId(event);
    // Treat missing OR empty query params as absent — an empty `to` would otherwise make the
    // DynamoDB BETWEEN have an upper bound < lower bound and throw a ValidationException (500).
    const fromParam = event.queryStringParameters?.from;
    const toParam = event.queryStringParameters?.to;
    const from = fromParam ? fromParam : defaultFrom();
    const to = toParam ? toParam : new Date().toISOString();

    // Aggregates are keyed pk=TENANT#<id>#USAGE, sk=<iso-bucket>.
    // A single Query returns at most 1 MB of items; follow LastEvaluatedKey so
    // the time series (and any KPI sums derived from it) is not silently truncated.
    const items: Record<string, any>[] = [];
    let lastEvaluatedKey: Record<string, any> | undefined;
    do {
      const res = await ddb.send(
        new QueryCommand({
          TableName: TABLE,
          KeyConditionExpression: 'pk = :pk AND sk BETWEEN :from AND :to',
          ExpressionAttributeValues: { ':pk': `TENANT#${tenantId}#USAGE`, ':from': from, ':to': to },
          ExclusiveStartKey: lastEvaluatedKey,
        }),
      );
      items.push(...(res.Items ?? []));
      lastEvaluatedKey = res.LastEvaluatedKey;
    } while (lastEvaluatedKey);

    return ok({
      tenantId,
      from,
      to,
      points: items.map((i) => ({
        timestamp: i.sk,
        // Quota accounting counts cache read/write tokens as input tokens; include
        // them so usage KPIs reconcile with the per-model quota table (F-007).
        inputTokens: (i.inputTokens ?? 0) + (i.cacheReadTokens ?? 0) + (i.cacheWriteTokens ?? 0),
        outputTokens: i.outputTokens ?? 0,
        invocations: i.invocations ?? 0,
        throttleErrors: i.throttleErrors ?? 0,
      })),
    });
  } catch (err) {
    console.error(err);
    return serverError();
  }
};

function defaultFrom(): string {
  const d = new Date();
  d.setDate(d.getDate() - 7);
  return d.toISOString();
}
