import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import {
  AthenaClient, StartQueryExecutionCommand, GetQueryExecutionCommand, GetQueryResultsCommand,
} from '@aws-sdk/client-athena';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ok, serverError } from '../shared/response';
import { getTenantId } from '../shared/tenant';

const athena = new AthenaClient({});
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const WORKGROUP = process.env.ATHENA_WORKGROUP!;
const DATABASE = process.env.GLUE_DATABASE!;
const AGGREGATES_TABLE = process.env.AGGREGATES_TABLE;
// Opus 4.8 rate as the default estimate; keep in sync with costs.ts / official pricing.
const IN = 0.000005, OUT = 0.000025, CACHE = 0.0000005;

/**
 * GET /v1/projects — usage attributed to projects, by joining Bedrock requestMetadata
 * (project_id / user_id) to a customer-supplied project mapping table (project_mapping),
 * loaded from a CSV in S3. Falls back to the raw project_id when no mapping row exists.
 *
 * Synchronous Athena run (start → poll → results) since the result set is small (one row per
 * project). For large tenants, switch to the async pattern used by /v1/queries.
 */
export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const tenantId = getTenantId(event);

    // Fast path (#7): ?source=fast reads pre-aggregated PROJECT rollups from DynamoDB — no Athena
    // scan. Returns project_id codes (no CSV name mapping); the default Athena path adds names.
    if (event.queryStringParameters?.source === 'fast' && AGGREGATES_TABLE) {
      return ok({ tenantId, source: 'dynamodb', projects: await fastProjects(tenantId) });
    }

    const sql = `
      SELECT
        COALESCE(m.project_name, l.requestMetadata['project_id'], 'untagged') AS project,
        COALESCE(m.cost_center, '—') AS cost_center,
        COUNT(DISTINCT l.requestMetadata['user_id']) AS users,
        SUM(l.input.inputTokenCount + l.output.outputTokenCount) AS tokens,
        SUM(l.input.inputTokenCount) * ${IN}
          + SUM(l.output.outputTokenCount) * ${OUT}
          + SUM(COALESCE(l.input.cacheReadInputTokenCount, 0)) * ${CACHE} AS est_usd
      FROM bedrock_invocation_logs l
      LEFT JOIN project_mapping m
        ON l.requestMetadata['project_id'] = m.project_id
      WHERE COALESCE(l.requestMetadata['tenant'], l.identity.arn) = '${sanitize(tenantId)}'
      GROUP BY 1, 2
      ORDER BY tokens DESC
      LIMIT 100`;

    const start = await athena.send(new StartQueryExecutionCommand({
      QueryString: sql, WorkGroup: WORKGROUP, QueryExecutionContext: { Database: DATABASE },
    }));
    const id = start.QueryExecutionId!;

    // Poll up to ~25s.
    let state: string | undefined;
    for (let i = 0; i < 25; i++) {
      const ex = await athena.send(new GetQueryExecutionCommand({ QueryExecutionId: id }));
      state = ex.QueryExecution?.Status?.State;
      if (state === 'SUCCEEDED') break;
      if (state === 'FAILED' || state === 'CANCELLED') {
        // Most common cause in a fresh deployment: project_mapping table not created yet.
        return ok({ projects: [], note: ex.QueryExecution?.Status?.StateChangeReason ?? state });
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    // Poll window elapsed while still RUNNING/QUEUED: don't fetch results on an
    // incomplete query (that errors and drops the connection — see F-004).
    if (state !== 'SUCCEEDED') {
      return ok({ projects: [], note: `timeout: ${state ?? 'UNKNOWN'}` });
    }

    const res = await athena.send(new GetQueryResultsCommand({ QueryExecutionId: id, MaxResults: 101 }));
    const rows = res.ResultSet?.Rows ?? [];
    const projects = rows.slice(1).map((r) => {
      const c = r.Data ?? [];
      return {
        projectName: c[0]?.VarCharValue ?? 'untagged',
        costCenter: c[1]?.VarCharValue ?? '—',
        users: Number(c[2]?.VarCharValue ?? 0),
        tokens: Number(c[3]?.VarCharValue ?? 0),
        estimatedUsd: Math.round(Number(c[4]?.VarCharValue ?? 0) * 1e6) / 1e6,
      };
    });
    return ok({ tenantId, projects });
  } catch (err) {
    console.error(err);
    return serverError();
  }
};

function sanitize(v: string): string {
  return v.replace(/'/g, "''").replace(/[^\w@.\-:/]/g, '');
}

/**
 * Fast per-project rollup from DynamoDB pre-aggregates (#7). Reads TENANT#<tenant>#PROJECT items
 * (sk = <projectId>#<modelId>), sums across models per project, applies the rate card, and unions
 * the distinct user sets. No Athena scan — single-digit-ms reads.
 */
async function fastProjects(tenantId: string): Promise<any[]> {
  const res = await ddb.send(new QueryCommand({
    TableName: AGGREGATES_TABLE,
    KeyConditionExpression: 'pk = :pk',
    ExpressionAttributeValues: { ':pk': `TENANT#${tenantId}#PROJECT` },
  }));
  const byProject = new Map<string, { tokens: number; estimatedUsd: number; users: Set<string> }>();
  for (const it of res.Items ?? []) {
    const projectId = String(it.projectId ?? 'untagged');
    const inTok = Number(it.inputTokens ?? 0);
    const outTok = Number(it.outputTokens ?? 0);
    const cacheTok = Number(it.cacheReadTokens ?? 0);
    const e = byProject.get(projectId) ?? { tokens: 0, estimatedUsd: 0, users: new Set<string>() };
    e.tokens += inTok + outTok;
    e.estimatedUsd += inTok * IN + outTok * OUT + cacheTok * CACHE;
    const us = it.userSet as Set<string> | string[] | undefined;
    if (us) for (const u of (us instanceof Set ? us : us)) e.users.add(u);
    byProject.set(projectId, e);
  }
  return [...byProject.entries()]
    .map(([projectId, v]) => ({
      projectId, projectName: projectId, costCenter: '—',
      users: v.users.size, tokens: v.tokens,
      estimatedUsd: Math.round(v.estimatedUsd * 1e6) / 1e6,
    }))
    .sort((a, b) => b.tokens - a.tokens);
}
