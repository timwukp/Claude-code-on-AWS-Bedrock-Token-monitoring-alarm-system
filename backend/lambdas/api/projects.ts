import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import {
  AthenaClient, StartQueryExecutionCommand, GetQueryExecutionCommand, GetQueryResultsCommand,
} from '@aws-sdk/client-athena';
import { ok, serverError } from '../shared/response';
import { getTenantId } from '../shared/tenant';

const athena = new AthenaClient({});
const WORKGROUP = process.env.ATHENA_WORKGROUP!;
const DATABASE = process.env.GLUE_DATABASE!;
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
        AND l.requestMetadata['project_id'] IS NOT NULL
      GROUP BY 1, 2
      ORDER BY tokens DESC
      LIMIT 100`;

    const start = await athena.send(new StartQueryExecutionCommand({
      QueryString: sql, WorkGroup: WORKGROUP, QueryExecutionContext: { Database: DATABASE },
    }));
    const id = start.QueryExecutionId!;

    // Poll up to ~25s.
    for (let i = 0; i < 25; i++) {
      const ex = await athena.send(new GetQueryExecutionCommand({ QueryExecutionId: id }));
      const state = ex.QueryExecution?.Status?.State;
      if (state === 'SUCCEEDED') break;
      if (state === 'FAILED' || state === 'CANCELLED') {
        // Most common cause in a fresh deployment: project_mapping table not created yet.
        return ok({ projects: [], note: ex.QueryExecution?.Status?.StateChangeReason ?? state });
      }
      await new Promise((r) => setTimeout(r, 1000));
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
