import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import {
  AthenaClient, StartQueryExecutionCommand, GetQueryExecutionCommand, GetQueryResultsCommand,
} from '@aws-sdk/client-athena';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ok, serverError } from '../shared/response';
import { computeModelCost, normalizeModelId, summarizeCosts, TokenCounts } from './cost-calc';
import { listProfiles, listProjects } from '../shared/project-registry';
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
 * GET /v1/projects — usage attributed to projects.
 *
 * Attribution precedence, the same order the aggregator applies so Fast and Full agree on which
 * tier wins: **AIP tag ▷ requestMetadata.project_id ▷ untagged.** The AIP tier resolves an
 * application-inference-profile ARN (which is what `modelId` holds for profile-routed calls)
 * through the profile cache; the metadata tier joins `requestMetadata.project_id` to the
 * customer-supplied `project_mapping` CSV in S3 for names and cost centres.
 *
 * Two tiers the Fast path has and this one deliberately does NOT, because they exist only as
 * DynamoDB state and no raw-log signal carries them: the admin **identity hint**, and the
 * one-time historical `HOUR_PROJECT_MAP` attribution. Raw logs stay immutable, so the Full view
 * reports call-time truth and pre-AIP history stays `untagged` here by design. The page says so.
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
      const [projects, totals, rollupsAsOf] = await Promise.all([fastProjects(tenantId), modelTotals(tenantId), rollupWatermark()]);
      // rollupsAsOf lets the UI explain Fast-vs-Athena residuals honestly: rollups refresh every
      // 15 min, Athena reads raw logs live — the difference is traffic since the watermark (F-801).
      return ok({ tenantId, source: 'dynamodb', projects, rollupsAsOf, ...totals });
    }

    // The Full view used to attribute from requestMetadata alone, so profile-routed traffic —
    // whose modelId IS the AIP ARN and which carries no project_id — could only ever land in
    // 'untagged' (qa F-1101: Athena showed 4 rows / 99.97% untagged where Fast showed 20
    // projects). The profile cache is the same self-healing source of truth the aggregator
    // maintains, so read it here and inline it rather than mirroring it into a second store.
    const [profileItems, registryProjects] = await Promise.all([
      listProfiles().catch((e) => {
        console.warn('projects: profile cache unreadable, AIP tier disabled', (e as Error).message);
        return [];
      }),
      listProjects().catch(() => []),
    ]);
    const profiles = profileItems.filter((p) => p.projectId && p.projectId !== 'untagged');
    const sql = buildFullSql(tenantId, profiles);

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
    // An AIP-attributed row is labelled with its project id when the project_mapping CSV has no
    // row for it; relabel from the registry so Full and Fast name the same project identically
    // (Fast already does this). Pure relabel — ids are unique, so no rows merge and no aggregate
    // is recomputed.
    const registry = new Map(registryProjects.map((p) => [p.projectId, { name: p.name, costCenter: p.costCenter ?? '—' }]));
    for (const p of athenaProjects) {
      const hit = registry.get(p.projectName);
      if (!hit) continue;
      p.projectName = hit.name;
      if (p.costCenter === '—') p.costCenter = hit.costCenter;
    }
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
 * Cap on inlined profile rows. One AIP exists per project × model, so a few dozen is the real
 * shape; the cap only stops a pathological cache from pushing the statement toward Athena's
 * 262 kB query limit. Truncation degrades attribution for the overflow, never the query.
 */
export const MAX_PROFILE_ROWS = 400;

/**
 * Build the Full-view (Athena) SQL. Attribution precedence mirrors the aggregator's, so Full and
 * Fast agree on which tier wins: **AIP tag ▷ requestMetadata ▷ untagged**.
 *
 * The profile→project mapping is inlined as a CTE of VALUES instead of being exported to S3 as a
 * second Glue table: the DynamoDB profile cache is already authoritative and self-healing, a
 * mirror would add a staleness window, and doing the fold in SQL keeps grouping single-pass —
 * folding profile rows into projects afterwards in the Lambda would break COUNT(DISTINCT user),
 * which cannot be re-aggregated across merged groups without over-counting shared users.
 *
 * Exported for unit tests: this is pure string building.
 */
export function buildFullSql(tenantId: string, profiles: { arn: string; projectId: string }[]): string {
  const rows = profiles.slice(0, MAX_PROFILE_ROWS)
    .map((p) => `('${sanitize(p.arn)}', '${sanitize(p.projectId)}')`)
    .join(', ');
  // An empty VALUES list is a syntax error, so with no resolved profiles emit the pre-#F-1101
  // shape: identical behaviour, one join fewer.
  const withClause = rows ? `WITH profile_map (profile_arn, project_id) AS (VALUES ${rows})\n      ` : '';
  const aipJoin = rows
    ? `LEFT JOIN profile_map ap
        ON l.modelId = ap.profile_arn
      LEFT JOIN project_mapping pm
        ON ap.project_id = pm.project_id
      `
    : '';
  // Name/cost-centre for an AIP-attributed row come from the same project_mapping CSV as the
  // metadata tier, so a project reads identically whichever tier attributed it.
  const project = rows
    ? "COALESCE(pm.project_name, ap.project_id, m.project_name, l.requestMetadata['project_id'], 'untagged')"
    : "COALESCE(m.project_name, l.requestMetadata['project_id'], 'untagged')";
  const costCenter = rows ? "COALESCE(pm.cost_center, m.cost_center, '—')" : "COALESCE(m.cost_center, '—')";
  return `
      ${withClause}SELECT
        ${project} AS project,
        ${costCenter} AS cost_center,
        COUNT(DISTINCT l.requestMetadata['user_id']) AS users,
        SUM(l.input.inputTokenCount + l.output.outputTokenCount) AS tokens,
        SUM(l.input.inputTokenCount) * ${IN}
          + SUM(l.output.outputTokenCount) * ${OUT}
          + SUM(COALESCE(l.input.cacheReadInputTokenCount, 0)) * ${CACHE} AS est_usd
      FROM bedrock_invocation_logs l
      ${aipJoin}LEFT JOIN project_mapping m
        ON l.requestMetadata['project_id'] = m.project_id
      WHERE COALESCE(l.requestMetadata['tenant'], l.identity.arn) = '${sanitize(tenantId)}'
      GROUP BY 1, 2
      ORDER BY tokens DESC
      LIMIT 100`;
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

/** ISO time of the last aggregator run (SYSTEM#WATERMARK), or null. */
async function rollupWatermark(): Promise<string | null> {
  try {
    const res = await ddb.send(new GetCommand({ TableName: AGGREGATES_TABLE, Key: { pk: 'SYSTEM#WATERMARK', sk: 'aggregator' } }));
    const ms = Number(res.Item?.lastModified);
    return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null;
  } catch { return null; }
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
