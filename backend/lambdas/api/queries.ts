import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import {
  AthenaClient,
  StartQueryExecutionCommand,
  GetQueryExecutionCommand,
  GetQueryResultsCommand,
} from '@aws-sdk/client-athena';
import { ok, badRequest, serverError } from '../shared/response';
import { RATE_CARD, cardByKeyLength, routeCaseSql } from './cost-calc';
import { listProfiles, profileResolvesModel } from '../shared/project-registry';
import { getTenantId } from '../shared/tenant';
import { invocationSource } from './invocation-source';

const athena = new AthenaClient({});
const WORKGROUP = process.env.ATHENA_WORKGROUP!;
const DATABASE = process.env.GLUE_DATABASE!;
const src = () => invocationSource();

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
const tenantFilter = (tenantId: string) => `(${src().tenantPredicate('l', sanitizeTenant(tenantId))})`;

/**
 * SQL CASE reproducing matchRate's longest-key-wins semantics (keys tested longest first, so the
 * first LIKE hit IS the longest) so Athena and the Fast path price identically; unknown → 0.
 */
function rateCase(
  field: 'inPerToken' | 'outPerToken' | 'cacheReadPerToken' | 'cacheWrite5mPerToken',
  modelExpr = 'l.modelId',
): string {
  const whens = cardByKeyLength(RATE_CARD).map((r) => `WHEN ${modelExpr} LIKE '%${r.key.replace(/'/g, "''")}%' THEN ${r[field]}`).join(' ');
  return `CASE ${whens} ELSE 0 END`;
}

const SAFE_SQL_STR = /^[A-Za-z0-9:._\/-]+$/;

/**
 * Build the effective-model expression from the registry's resolved-profile cache (F-501): calls
 * routed through an application inference profile log the opaque profile ARN as modelId, which
 * no rate matches — the rollups resolve them at ingest, so Athena must too or the pipelines
 * disagree by exactly the profile-routed spend. Strings are allow-listed before interpolation.
 */
async function buildModelExpr(): Promise<string> {
  if (!process.env.TENANTS_TABLE) return 'l.modelId';
  try {
    // Every profile whose model is known, tagged or not: the model is for pricing, the tag is for
    // attribution (projectExprFrom), and the two are independent (feature-36, qa F-PR68-002).
    const whens = (await listProfiles())
      .filter((p) => profileResolvesModel(p) && SAFE_SQL_STR.test(p.arn) && SAFE_SQL_STR.test(p.underlyingModelId))
      .map((p) => `WHEN l.modelId = '${p.arn}' THEN '${p.underlyingModelId}'`);
    return whens.length ? `CASE ${whens.join(' ')} ELSE l.modelId END` : 'l.modelId';
  } catch (err) {
    console.warn('queries: could not load profile cache; pricing raw modelId', (err as Error).message);
    return 'l.modelId';
  }
}

/**
 * Profile ARN → project id, as a CASE with **no ELSE**: a non-profile call yields NULL so the
 * caller's COALESCE falls through to the next attribution tier. Same cache, same guard and same
 * failure posture as buildModelExpr — an unreadable cache disables the tier rather than failing
 * the query, which degrades attribution to the pre-fix behaviour instead of breaking the page.
 */
export function projectExprFrom(profiles: { arn: string; projectId?: string }[]): string | null {
  const whens = profiles
    .filter((p) => p.projectId && p.projectId !== 'untagged'
      && SAFE_SQL_STR.test(p.arn) && SAFE_SQL_STR.test(p.projectId))
    .map((p) => `WHEN l.modelId = '${p.arn}' THEN '${p.projectId}'`);
  return whens.length ? `CASE ${whens.join(' ')} END` : null;
}

async function buildProjectExpr(): Promise<string | null> {
  if (!process.env.TENANTS_TABLE) return null;
  try {
    return projectExprFrom(await listProfiles());
  } catch (err) {
    console.warn('queries: could not load profile cache; AIP attribution tier disabled', (err as Error).message);
    return null;
  }
}

interface TemplateCtx {
  /** SQL expression yielding the effective model id: application-inference-profile ARNs resolved
   * to their underlying model via the registry cache (so pricing matches the rollups), else l.modelId. */
  modelExpr: string;
  /** SQL expression yielding the project an AIP-routed call belongs to, or NULL when the call was
   * not profile-routed — deliberately no ELSE, so a COALESCE falls through to the next tier.
   * `null` when nothing resolves, so the template omits the tier entirely. */
  projectExpr: string | null;
}

export const TEMPLATES: Record<string, (tenantId: string, days: number, ctx: TemplateCtx) => string> = {
  // By-project attribution with the CSV name mapping, exposed async because the scan takes
  // 15-30s on real data (F-002). Prices PER MODEL with the same rate card the Fast path and the
  // Cost page use (QA F-402: a flat reference rate + proportional scaling mis-priced projects
  // with a cheaper model mix). Rows are (project, model); the client sums per project.
  // Attribution precedence matches the aggregator's — AIP tag ▷ requestMetadata ▷ untagged. Before
  // the AIP tier existed here, profile-routed calls (modelId = the AIP ARN, no project_id in
  // requestMetadata) could only land in 'untagged', so this view reported ~99.97% untagged against
  // 20 attributed projects in Fast (qa F-1101). The two tiers still absent are the ones with no
  // raw-log signal at all: the admin identity hint and the one-time historical treatment.
  byProject: (tenantId, days, ctx) => {
    const s = src();
    return `
    SELECT
      COALESCE(${ctx.projectExpr ? `${ctx.projectExpr}, ` : ''}m.project_name, ${s.meta('l', 'project_id')}, 'untagged') AS project,
      COALESCE(m.cost_center, '—') AS cost_center,
      COUNT(DISTINCT ${s.meta('l', 'user_id')}) AS users,
      COALESCE(SUM(${s.inputTokens('l')} + ${s.outputTokens('l')}), 0) AS tokens,
      (COALESCE(SUM(${s.inputTokens('l')}), 0) * (${rateCase('inPerToken', ctx.modelExpr)})
        + COALESCE(SUM(${s.outputTokens('l')}), 0) * (${rateCase('outPerToken', ctx.modelExpr)})
        + COALESCE(SUM(${s.cacheReadTokens('l')}), 0) * (${rateCase('cacheReadPerToken', ctx.modelExpr)})
        + COALESCE(SUM(${s.cacheWriteTokens('l')}), 0) * (${rateCase('cacheWrite5mPerToken', ctx.modelExpr)}))
        * (${routeCaseSql(ctx.modelExpr)}) AS est_usd
    FROM ${s.table} l
    LEFT JOIN project_mapping m
      ON ${s.meta('l', 'project_id')} = m.project_id
    WHERE ${tenantFilter(tenantId)}
      ${s.recentDays('l', days)}
    GROUP BY 1, 2, ${ctx.modelExpr}
    ORDER BY tokens DESC
    LIMIT 500`;
  },

  topModels: (tenantId, days) => {
    const s = src();
    return `
    SELECT ${s.modelId('l')} AS modelId,
           SUM(${s.inputTokens('l')} + ${s.outputTokens('l')}) AS total_tokens,
           SUM(${s.cacheReadTokens('l')}) AS cache_read_tokens,
           COUNT(*) AS invocations
    FROM ${s.table} l
    WHERE ${tenantFilter(tenantId)}
      ${s.recentDays('l', days)}
      AND ${s.timestamp('l')} >= date_add('day', -${days}, current_timestamp)
    GROUP BY 1 ORDER BY total_tokens DESC LIMIT 20`;
  },

  hourlyUsage: (tenantId, days) => {
    const s = src();
    return `
    SELECT date_trunc('hour', ${s.timestamp('l')}) AS hour,
           SUM(${s.inputTokens('l')}) AS input_tokens,
           SUM(${s.outputTokens('l')}) AS output_tokens,
           COUNT(*) AS invocations
    FROM ${s.table} l
    WHERE ${tenantFilter(tenantId)}
      ${s.recentDays('l', days)}
      AND ${s.timestamp('l')} >= date_add('day', -${days}, current_timestamp)
    GROUP BY 1 ORDER BY 1 DESC LIMIT 200`;
  },
};

async function startQuery(event: APIGatewayProxyEvent, tenantId: string) {
  const body = JSON.parse(event.body ?? '{}');
  const template = TEMPLATES[body.template];
  if (!template) return badRequest(`Unknown template. Allowed: ${Object.keys(TEMPLATES).join(', ')}`);
  const days = Math.min(Math.max(Number(body.days ?? 7), 1), 90);

  const [modelExpr, projectExpr] = await Promise.all([buildModelExpr(), buildProjectExpr()]);
  const ctx: TemplateCtx = { modelExpr, projectExpr };
  const res = await athena.send(
    new StartQueryExecutionCommand({
      QueryString: template(tenantId, days, ctx),
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
