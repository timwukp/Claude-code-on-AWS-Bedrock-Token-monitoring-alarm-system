import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ok, badRequest, serverError } from '../shared/response';
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
    const range = usageRange(event.queryStringParameters?.from, event.queryStringParameters?.to);
    if ('error' in range) return badRequest(range.error);
    const { from, to } = range;

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
        // Real (billed-as-input) tokens only — the same definition the Cost and By-Project
        // pages use, so cross-page totals reconcile (F-001). Cache read/write tokens are
        // returned as their own fields: quota accounting counts them as input (F-007), so the
        // page shows them separately with that caveat instead of inflating "Input tokens".
        inputTokens: i.inputTokens ?? 0,
        cacheReadTokens: i.cacheReadTokens ?? 0,
        cacheWriteTokens: i.cacheWriteTokens ?? 0,
        cacheWrite5mTokens: i.cacheWrite5mTokens ?? 0,
        cacheWrite1hTokens: i.cacheWrite1hTokens ?? 0,
        outputTokens: i.outputTokens ?? 0,
        invocations: i.invocations ?? 0,
        throttleErrors: i.throttleErrors ?? 0,
        // Expose non-throttle 4xx counts as their own field so the banner
        // renders them as a separate templated segment instead of appending
        // raw text to the throttling message (F-103 / prior N-003 run-on).
        clientErrors: i.clientErrors ?? 0,
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

export const USAGE_MAX_DAYS = 90;

/**
 * The query window as ISO strings, or an error: both bounds must be valid ISO-8601 timestamps, from ≤ to, and the
 * span ≤ 90 days. Unbounded or malformed bounds used to reach DynamoDB (every USAGE item loaded, or a
 * ValidationException surfacing as 500) — feature-49, audit #18.
 */
export function usageRange(fromParam: string | undefined, toParam: string | undefined): { from: string; to: string } | { error: string } {
  const parse = (v: string | undefined, dflt: () => string) => {
    if (v === undefined || v === '') return dflt();
    const t = Date.parse(v);
    return Number.isFinite(t) && /^\d{4}-\d{2}-\d{2}/.test(v) ? new Date(t).toISOString() : null;
  };
  const from = parse(fromParam, defaultFrom);
  const to = parse(toParam, () => new Date().toISOString());
  if (from === null || to === null) return { error: 'from/to must be ISO-8601 timestamps (e.g. 2026-10-01T00:00:00Z)' };
  if (from > to) return { error: 'from must not be after to' };
  if (Date.parse(to) - Date.parse(from) > USAGE_MAX_DAYS * 86_400_000) return { error: `window must be at most ${USAGE_MAX_DAYS} days` };
  return { from, to };
}
