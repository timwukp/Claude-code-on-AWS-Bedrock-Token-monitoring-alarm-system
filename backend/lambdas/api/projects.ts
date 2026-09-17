import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import {
  AthenaClient, StartQueryExecutionCommand, GetQueryExecutionCommand, GetQueryResultsCommand,
} from '@aws-sdk/client-athena';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ok, serverError } from '../shared/response';
import { computeModelCost, normalizeModelId, summarizeCosts, TokenCounts } from './cost-calc';
import { listProjects } from '../shared/project-registry';
import { getTenantId } from '../shared/tenant';

const athena = new AthenaClient({});
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const WORKGROUP = process.env.ATHENA_WORKGROUP!;
const DATABASE = process.env.GLUE_DATABASE!;
const AGGREGATES_TABLE = process.env.AGGREGATES_TABLE;
// Opus 4.8 rate as the default estimate; keep in sync with costs.ts / official pricing.
// Reference rates for project attribution (Opus-tier). PROJECT rollups don't record which
// model served each request, so exact per-model pricing (what /v1/costs does) is impossible
// here — this is a uniform-rate approximation and will NOT match the Cost page total.
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
      // #13: rows are priced per (project, model) with the shared rate card (the PROJECT sk has
      // always carried modelId), and registry names/cost centers replace raw ids. Same ids +
      // same card as /v1/costs → totals agree by construction, no scaling needed.
      const [projects, totals] = await Promise.all([fastProjects(tenantId), modelTotals(tenantId)]);
      return ok({ tenantId, source: 'dynamodb', projects, ...totals });
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

    // Poll against a wall-clock deadline — iteration counting undercounts because each
    // loop also pays Athena API latency; must finish within the Lambda timeout (28s for this
    // function), otherwise the runtime kills the invocation mid-poll and the browser sees
    // status 0 (F-002). 22s of polling + start/results/scaling fits with headroom.
    const deadline = Date.now() + 22_000;
    let state: string | undefined;
    while (true) {
      const ex = await athena.send(new GetQueryExecutionCommand({ QueryExecutionId: id }));
      state = ex.QueryExecution?.Status?.State;
      if (state === 'SUCCEEDED') break;
      if (state === 'FAILED' || state === 'CANCELLED') {
        // Most common cause in a fresh deployment: project_mapping table not created yet.
        return ok({ projects: [], note: ex.QueryExecution?.Status?.StateChangeReason ?? state });
      }
      if (Date.now() >= deadline) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    // Poll window elapsed while still RUNNING/QUEUED: don't fetch results on an
    // incomplete query (that errors and drops the connection — see F-004).
    if (state !== 'SUCCEEDED') {
      return ok({ projects: [], note: `timeout: ${state ?? 'UNKNOWN'}` });
    }

    const res = await athena.send(new GetQueryResultsCommand({ QueryExecutionId: id, MaxResults: 101 }));
    const rows = res.ResultSet?.Rows ?? [];
    const athenaProjects = rows.slice(1).map((r) => {
      const c = r.Data ?? [];
      return {
        projectName: c[0]?.VarCharValue ?? 'untagged',
        costCenter: c[1]?.VarCharValue ?? '—',
        users: Number(c[2]?.VarCharValue ?? 0),
        tokens: Number(c[3]?.VarCharValue ?? 0),
        estimatedUsd: Math.round(Number(c[4]?.VarCharValue ?? 0) * 1e6) / 1e6,
      };
    });
    // Same treatment as the fast path: scale rows to the authoritative per-model totals so
    // Fast, Full, and the Cost page all agree (Athena prices at flat reference rates and its
    // log coverage window differs from the rollups).
    const totals = AGGREGATES_TABLE ? await modelTotals(tenantId) : null;
    if (totals) {
      const rowSum = athenaProjects.reduce((t, p) => t + (p.estimatedUsd ?? 0), 0);
      if (rowSum > 0 && totals.totalEstimatedUsd > 0) {
        const k = totals.totalEstimatedUsd / rowSum;
        for (const p of athenaProjects) p.estimatedUsd = Math.round(p.estimatedUsd * k * 1e6) / 1e6;
      }
      const tokSum = athenaProjects.reduce((t, p) => t + (p.tokens ?? 0), 0);
      if (tokSum > 0 && totals.totalTokens > 0) {
        const k2 = totals.totalTokens / tokSum;
        for (const p of athenaProjects) p.tokens = Math.round(p.tokens * k2);
      }
    }
    return ok({ tenantId, projects: athenaProjects, ...(totals ?? {}) });
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
/** Page-level totals from the SAME #MODEL rollups and rate card the Cost page uses, so the
 * two pages agree numerically. Per-project rows keep uniform reference rates (attribution
 * only — PROJECT rollups don't record modelId). */
async function modelTotals(tenantId: string): Promise<{ totalTokens: number; totalEstimatedUsd: number }> {
  const res = await ddb.send(new QueryCommand({
    TableName: AGGREGATES_TABLE,
    KeyConditionExpression: 'pk = :pk',
    ExpressionAttributeValues: { ':pk': `TENANT#${tenantId}#MODEL` },
  }));
  const items: TokenCounts[] = (res.Items ?? []).map((i: any) => ({
    modelId: String(i.modelId ?? ''),
    inputTokens: Number(i.inputTokens ?? 0),
    outputTokens: Number(i.outputTokens ?? 0),
    cacheReadTokens: Number(i.cacheReadTokens ?? 0),
  }));
  const s = summarizeCosts(items);
  const totalTokens = s.byModel.reduce((t, m) => t + m.inputTokens + m.outputTokens, 0);
  return { totalTokens, totalEstimatedUsd: s.totalEstimatedUsd };
}

async function fastProjects(tenantId: string): Promise<any[]> {
  const [res, registryProjects] = await Promise.all([
    ddb.send(new QueryCommand({
      TableName: AGGREGATES_TABLE,
      KeyConditionExpression: 'pk = :pk',
      ExpressionAttributeValues: { ':pk': `TENANT#${tenantId}#PROJECT` },
    })),
    // Registry names/cost centers (#13); tolerate an empty/missing registry.
    listProjects().catch(() => []),
  ]);
  const names = new Map(registryProjects.map((p) => [p.projectId, { name: p.name, costCenter: p.costCenter ?? '—' }]));
  const byProject = new Map<string, { tokens: number; estimatedUsd: number; users: Set<string> }>();
  for (const it of res.Items ?? []) {
    const projectId = String(it.projectId ?? 'untagged');
    const e = byProject.get(projectId) ?? { tokens: 0, estimatedUsd: 0, users: new Set<string>() };
    e.tokens += Number(it.inputTokens ?? 0) + Number(it.outputTokens ?? 0);
    // Per-model pricing (#13): the sk has always carried modelId — use the real rate card.
    e.estimatedUsd += computeModelCost({
      modelId: normalizeModelId(String(it.modelId ?? '')),
      inputTokens: Number(it.inputTokens ?? 0),
      outputTokens: Number(it.outputTokens ?? 0),
      cacheReadTokens: Number(it.cacheReadTokens ?? 0),
    }).estimatedUsd;
    const us = it.userSet as Set<string> | string[] | undefined;
    if (us) for (const u of (us instanceof Set ? us : us)) e.users.add(u);
    byProject.set(projectId, e);
  }
  return [...byProject.entries()]
    .map(([projectId, v]) => ({
      projectId,
      projectName: names.get(projectId)?.name ?? projectId,
      costCenter: names.get(projectId)?.costCenter ?? '—',
      users: v.users.size, tokens: v.tokens,
      estimatedUsd: Math.round(v.estimatedUsd * 1e6) / 1e6,
    }))
    .sort((a, b) => b.tokens - a.tokens);
}
