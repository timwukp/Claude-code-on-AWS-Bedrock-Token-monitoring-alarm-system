import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import {
  AthenaClient,
  StartQueryExecutionCommand,
  GetQueryExecutionCommand,
  GetQueryResultsCommand,
} from '@aws-sdk/client-athena';
import { ok, badRequest, serverError } from '../shared/response';
import { getTenantId } from '../shared/tenant';

const athena = new AthenaClient({});
const WORKGROUP = process.env.ATHENA_WORKGROUP!;
const DATABASE = process.env.GLUE_DATABASE!;

/**
 * Forensic query endpoint (async Athena pattern):
 *   POST /v1/queries        → start a vetted, tenant-scoped query, returns {id}
 *   GET  /v1/queries/{id}   → poll status; returns rows when SUCCEEDED
 *
 * Only a fixed set of parameterised, server-side templates are allowed — never raw SQL from the
 * client — and every template is filtered by the caller's tenant (Security pillar).
 */
export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const tenantId = getTenantId(event);
    if (event.httpMethod === 'POST') return startQuery(event, tenantId);
    if (event.httpMethod === 'GET') return pollQuery(event);
    return badRequest('Unsupported method');
  } catch (err) {
    console.error(err);
    return serverError();
  }
};

/**
 * Tenant filter mirrors the aggregator's derivation: match either an explicit
 * requestMetadata['tenant'] tag OR the caller IAM ARN (identity.arn), so the forensic queries
 * resolve the same tenant the dashboard aggregates use. (Verified against real logs.)
 */
const tenantFilter = (tenantId: string) => {
  const t = sanitizeTenant(tenantId);
  return `(COALESCE(requestMetadata['tenant'], identity.arn) = '${t}')`;
};

const TEMPLATES: Record<string, (tenantId: string, days: number) => string> = {
  topModels: (tenantId, days) => `
    SELECT modelId,
           SUM(input.inputTokenCount + output.outputTokenCount) AS total_tokens,
           SUM(input.cacheReadInputTokenCount) AS cache_read_tokens,
           COUNT(*) AS invocations
    FROM bedrock_invocation_logs
    WHERE ${tenantFilter(tenantId)}
      AND from_iso8601_timestamp("timestamp") >= date_add('day', -${days}, current_timestamp)
    GROUP BY modelId ORDER BY total_tokens DESC LIMIT 20`,

  hourlyUsage: (tenantId, days) => `
    SELECT date_trunc('hour', from_iso8601_timestamp("timestamp")) AS hour,
           SUM(input.inputTokenCount) AS input_tokens,
           SUM(output.outputTokenCount) AS output_tokens,
           COUNT(*) AS invocations
    FROM bedrock_invocation_logs
    WHERE ${tenantFilter(tenantId)}
      AND from_iso8601_timestamp("timestamp") >= date_add('day', -${days}, current_timestamp)
    GROUP BY 1 ORDER BY 1 DESC LIMIT 200`,
};

async function startQuery(event: APIGatewayProxyEvent, tenantId: string) {
  const body = JSON.parse(event.body ?? '{}');
  const template = TEMPLATES[body.template];
  if (!template) return badRequest(`Unknown template. Allowed: ${Object.keys(TEMPLATES).join(', ')}`);
  const days = Math.min(Math.max(Number(body.days ?? 7), 1), 90);

  const res = await athena.send(
    new StartQueryExecutionCommand({
      QueryString: template(tenantId, days),
      WorkGroup: WORKGROUP,
      QueryExecutionContext: { Database: DATABASE },
    }),
  );
  return ok({ id: res.QueryExecutionId });
}

async function pollQuery(event: APIGatewayProxyEvent) {
  const id = event.pathParameters?.id;
  if (!id) return badRequest('Missing query id');

  const exec = await athena.send(new GetQueryExecutionCommand({ QueryExecutionId: id }));
  const state = exec.QueryExecution?.Status?.State;
  if (state !== 'SUCCEEDED') return ok({ id, state });

  const results = await athena.send(new GetQueryResultsCommand({ QueryExecutionId: id, MaxResults: 100 }));
  return ok({ id, state, rows: results.ResultSet?.Rows ?? [] });
}

/**
 * Defensive: tenant ids come from JWT claims, but never interpolate untrusted text unescaped.
 * Allow the characters that legitimately appear in IAM ARNs and metadata tag values
 * (incl. '/' in `user/name`), escape single quotes for SQL string-literal safety, and drop
 * anything else. Note the '/' MUST be allowed or IAM-ARN tenants never match.
 */
export function sanitizeTenant(v: string): string {
  return v.replace(/'/g, "''").replace(/[^\w@.\-:/]/g, '');
}
