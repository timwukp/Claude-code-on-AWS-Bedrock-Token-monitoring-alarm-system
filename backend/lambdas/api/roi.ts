/**
 * AI-coding ROI API (#14) — one read-only Lambda:
 *
 *   GET /v1/roi/projects?window=30|90   retrospective ROI per registry project
 *   GET /v1/roi/estimate?reference=<projectId>&prsPerMonth=<n>[&teamSize&loadedCostPerYear]
 *                                       forward budget band + projected break-even
 *
 * The math lives in roi-calc.ts (pure, DORA-calculator provenance — see
 * docs/ROI_METHODOLOGY.md). Assumption precedence: project.roi ▷ org defaults ▷ code defaults,
 * with the effective source disclosed per project. Windows are 30/90 only: annualizing a
 * 7-day window is statistically indefensible.
 */
import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { badRequest, notFound, ok, serverError } from '../shared/response';
import { getTenantId } from '../shared/tenant';
import { isAdmin } from '../shared/admin';
import { computeDora } from '../dora/dora-calc';
import * as doraStore from '../dora/store';
import * as registry from '../shared/project-registry';
import { ProjdayItem, projdayRange } from './project-calc';
import {
  RCT_BRACKET, ROI_DEFAULTS, ReferenceBands, RoiAssumptions, RoiResult, RoiWindowAggregates,
  WeeklyPoint, computeRoi, estimateForward, killFastFlag, referenceBands, weeklyFromProjday,
} from './roi-calc';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const AGGREGATES_TABLE = process.env.AGGREGATES_TABLE;
const WINDOWS = [30, 90] as const;
const DAY = 86_400_000;

export interface RoiProjectRow {
  projectId: string;
  name: string;
  category: string | null;
  assumptionsSource: 'project' | 'org-default' | 'code-default';
  roi: RoiResult;
  bands: ReferenceBands;
  killFast: { flagged: boolean; weeks: string[]; rule: string };
  monthlySpendUsd: number;
  mergedPrs: number;
}

const METHODOLOGY = {
  framing: 'High-uncertainty estimates meant to spark a conversation — not a rigid formula (DORA).',
  bracket: RCT_BRACKET,
  refuses: [
    'Attributing revenue to the coding assistant beyond the disclosed DORA conventions (33% idea-success, 0.01–1% impact).',
    'Survey- or perception-based time savings (METR: devs believed +20% while measured −19%).',
    'A single cross-project productivity multiplier (DORA 2025: AI amplifies existing strengths/weaknesses).',
    'Causal AI-vs-human deltas from observational PR cohorts — run a holdout for causal claims.',
    'A composite ROI for a window that shipped nothing — with no merged PRs and no deployments '
      + 'the value side is assumption-only, so only the measured spend and break-even are shown.',
    'A composite ROI for a project with no staffing of its own configured — borrowing a shared '
      + 'teamSize would claim one team\'s saving once per project. Set it in the drawer below.',
    'A percentage return on spend smaller than one engineer-hour per month — the ratio would be '
      + 'division noise, so the measured spend is shown without one.',
  ],
  annualization: 'Rate-like terms scale by 365/window; one-time costs (training, J-curve) do not.',
};

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    getTenantId(event);
    const route = `${event.httpMethod} ${event.resource}`;
    switch (route) {
      case 'GET /v1/roi/projects': return projects(event);
      case 'GET /v1/roi/estimate': return estimate(event);
      default: return notFound(`Unknown route ${route}`);
    }
  } catch (err) {
    console.error(err);
    return serverError();
  }
};

function parseWindow(raw: string | undefined): 30 | 90 | null {
  if (raw == null || raw === '') return 90;
  const n = Number(raw);
  return (WINDOWS as readonly number[]).includes(n) ? (n as 30 | 90) : null;
}

async function queryProjday(tenantId: string, now: Date, windowDays: number): Promise<ProjdayItem[]> {
  const { fromSk, toSk } = projdayRange(now, windowDays);
  const out: ProjdayItem[] = [];
  let key: Record<string, unknown> | undefined;
  do {
    const res = await ddb.send(new QueryCommand({
      TableName: AGGREGATES_TABLE,
      KeyConditionExpression: 'pk = :pk AND sk BETWEEN :from AND :to',
      ExpressionAttributeValues: { ':pk': `TENANT#${tenantId}#PROJDAY`, ':from': fromSk, ':to': toSk },
      ExclusiveStartKey: key,
    }));
    for (const it of (res.Items ?? []) as Record<string, unknown>[]) {
      out.push({
        day: String(it.day ?? ''), projectId: String(it.projectId ?? 'untagged'),
        modelId: String(it.modelId ?? ''), inputTokens: Number(it.inputTokens ?? 0),
        outputTokens: Number(it.outputTokens ?? 0), cacheReadTokens: Number(it.cacheReadTokens ?? 0),
        invocations: Number(it.invocations ?? 0),
      });
    }
    key = res.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (key);
  return out;
}

function mergeAssumptions(
  project: registry.RegistryProject,
  orgDefaults: registry.ProjectRoiConfig,
): { assumptions: RoiAssumptions; source: RoiProjectRow['assumptionsSource'] } {
  const source: RoiProjectRow['assumptionsSource'] =
    project.roi && Object.keys(project.roi).length ? 'project'
      : Object.keys(orgDefaults).length ? 'org-default' : 'code-default';
  return { assumptions: { ...ROI_DEFAULTS, ...orgDefaults, ...(project.roi ?? {}) }, source };
}

/** ISO-Monday weekly merged-PR counts from raw PR items. */
function weeklyPrs(prs: readonly { mergedAt: string }[]): WeeklyPoint[] {
  const m = new Map<string, number>();
  for (const p of prs) {
    const d = new Date(p.mergedAt.slice(0, 10) + 'T00:00:00Z');
    const monday = new Date(d.getTime() - ((d.getUTCDay() || 7) - 1) * DAY).toISOString().slice(0, 10);
    m.set(monday, (m.get(monday) ?? 0) + 1);
  }
  return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([weekStart, value]) => ({ weekStart, value }));
}

async function projects(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const windowDays = parseWindow(event.queryStringParameters?.window ?? undefined);
  if (windowDays == null) return badRequest(`window must be one of ${WINDOWS.join(', ')} (7-day ROI would be statistically indefensible)`);
  const tenantId = getTenantId(event);
  const now = new Date();
  const fromIso = new Date(now.getTime() - windowDays * DAY).toISOString();

  const [regProjects, orgDefaults, doraRepos, projday] = await Promise.all([
    registry.listProjects(), registry.getRoiDefaults(), doraStore.listRepos(), queryProjday(tenantId, now, windowDays),
  ]);
  const tracked = new Set(doraRepos.map((r) => r.sk));
  const byProject = new Map<string, ProjdayItem[]>();
  for (const it of projday) {
    const arr = byProject.get(it.projectId) ?? [];
    arr.push(it);
    byProject.set(it.projectId, arr);
  }

  const rows: RoiProjectRow[] = await Promise.all(regProjects.map(async (p) => {
    const items = byProject.get(p.projectId) ?? [];
    const { spend: weeklySpendUsd, tokens: weeklyTokens } = weeklyFromProjday(items);
    const spendUsd = weeklySpendUsd.reduce((t, w) => t + w.value, 0);
    const tokens = weeklyTokens.reduce((t, w) => t + w.value, 0);

    const repos = p.repos.filter((r) => tracked.has(r));
    const prsArrays = await Promise.all(repos.map((r) => doraStore.queryPrs(r, fromIso)));
    const issuesArrays = await Promise.all(repos.map((r) => doraStore.queryIssues(r, fromIso)));
    const prs = prsArrays.flat();
    const dora = computeDora(prs, issuesArrays.flat(), { windowDays, now });

    const agg: RoiWindowAggregates = {
      windowDays, spendUsd, tokens,
      mergedPrs: dora.sample.mergedPrs,
      deployments: dora.deploymentFrequency.all.deployments,
      cfrPct: dora.changeFailRate.all.value,
      mttrHours: dora.mttr.all.value,
      weeklySpendUsd, weeklyTokens,
      weeklyMergedPrs: weeklyPrs(prs.filter((x) => x.mergedAt >= fromIso)),
    };
    const { assumptions, source } = mergeAssumptions(p, orgDefaults);
    // Per-project ROI needs the team that actually worked on THIS project; a shared default
    // would claim one team's saving once per project (see computeRoi's staffing guard).
    const perProjectStaffing = p.roi?.teamSize != null && p.roi?.loadedCostPerYear != null;
    const roi = computeRoi(agg, assumptions, { perProjectStaffing });
    if (repos.length === 0) roi.refusals.push('No DORA-tracked repos linked — delivery-side terms are unavailable.');
    const bands = referenceBands(agg.weeklySpendUsd, agg.weeklyMergedPrs);
    const killFast = killFastFlag(agg.weeklySpendUsd, agg.weeklyMergedPrs);
    return {
      projectId: p.projectId, name: p.name, category: p.roi?.category ?? null,
      assumptionsSource: source, roi, bands, killFast,
      monthlySpendUsd: Math.round((spendUsd / windowDays) * 30.44 * 100) / 100,
      mergedPrs: dora.sample.mergedPrs,
    };
  }));

  rows.sort((a, b) => b.monthlySpendUsd - a.monthlySpendUsd);
  return ok({ window: windowDays, projects: rows, orgDefaults, isAdmin: isAdmin(event), methodology: METHODOLOGY });
}

async function estimate(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const q = event.queryStringParameters ?? {};
  const reference = (q.reference ?? '').trim().toLowerCase();
  const prsPerMonth = Number(q.prsPerMonth);
  if (!reference) return badRequest('reference (an existing projectId) is required');
  if (!Number.isFinite(prsPerMonth) || prsPerMonth <= 0 || prsPerMonth > 10_000) {
    return badRequest('prsPerMonth must be a positive number');
  }
  const tenantId = getTenantId(event);
  const project = await registry.getProject(reference);
  if (!project) return notFound(`${reference} is not a registered project`);

  const now = new Date();
  const [orgDefaults, projday] = await Promise.all([registry.getRoiDefaults(), queryProjday(tenantId, now, 90)]);
  const items = projday.filter((it) => it.projectId === project.projectId);
  const { spend } = weeklyFromProjday(items);

  const fromIso = new Date(now.getTime() - 90 * DAY).toISOString();
  const doraRepos = await doraStore.listRepos();
  const tracked = new Set(doraRepos.map((r) => r.sk));
  const prs = (await Promise.all(
    project.repos.filter((r) => tracked.has(r)).map((r) => doraStore.queryPrs(r, fromIso)),
  )).flat();

  const bands = referenceBands(spend, weeklyPrs(prs));
  const { assumptions } = mergeAssumptions(project, orgDefaults);
  const teamSize = Number(q.teamSize ?? assumptions.teamSize);
  const loadedCostPerYear = Number(q.loadedCostPerYear ?? assumptions.loadedCostPerYear);
  if (!Number.isFinite(teamSize) || teamSize <= 0 || !Number.isFinite(loadedCostPerYear) || loadedCostPerYear <= 0) {
    return badRequest('teamSize and loadedCostPerYear must be positive numbers');
  }
  const est = estimateForward(bands, prsPerMonth, { teamSize, loadedCostPerYear });
  return ok({
    reference: { projectId: project.projectId, name: project.name },
    prsPerMonth, teamSize, loadedCostPerYear, bands, ...est, methodology: METHODOLOGY,
  });
}
