/**
 * DORA metrics API — one Lambda, routed on method + resource (same pattern as queries.ts):
 *
 *   GET    /v1/dora/repos                          list tracked repos (+ tokenConfigured, isAdmin)
 *   POST   /v1/dora/repos            {repo}        [admin] register a repo and kick a sync
 *   DELETE /v1/dora/repos/{owner}/{name}           [admin] remove a repo and all its data
 *   POST   /v1/dora/repos/{owner}/{name}/sync      [admin] sync now (async collector invoke)
 *   GET    /v1/dora/metrics?repo=&window=          4 DORA metrics (all / AI / human) + timeline
 *   GET    /v1/dora/overview?window=               one row per repo, for the comparison table
 *
 * "Deployment" = PR merged to the default branch (none of the tracked repos use the GitHub
 * Deployments API). Metrics are computed on read from the raw PR / issue items the collector
 * stores, so the metrics and overview endpoints can never disagree.
 */
import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { accepted, badRequest, created, forbidden, notFound, ok, serverError } from '../shared/response';
import { getTenantId } from '../shared/tenant';
import { isAdmin } from '../shared/admin';
import { computeDora, DoraMetrics, MetricValue } from '../dora/dora-calc';
import { newRepoItem } from '../dora/collector';
import { GhRepo, GithubHttpError, createGithubClient } from '../dora/github-client';
import { loadGithubToken } from '../dora/secret';
import * as store from '../dora/store';
import { buildProjectRows, projdayRange, DoraProjectRow, ProjdayItem } from './project-calc';
import * as projectRegistry from '../shared/project-registry';
import { AssistedBy, PrItem, RepoItem, SyncStatus } from '../dora/types';

const lambdaClient = new LambdaClient({});
const ddbAgg = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const AGGREGATES_TABLE = process.env.AGGREGATES_TABLE;
const COLLECTOR = process.env.DORA_COLLECTOR_FUNCTION_NAME;
const WINDOWS = [7, 30, 90] as const;
const REPO_RE = /^[\w.-]+\/[\w.-]+$/;
const DAY = 86_400_000;

export interface RepoSummary {
  repo: string;
  owner: string;
  name: string;
  defaultBranch: string;
  addedBy: string;
  addedAt: string;
  lastSyncedAt: string | null;
  status: SyncStatus;
  error?: string;
  prCount: number;
  incidentCount: number;
}

export interface PrRow {
  number: number;
  title: string;
  author: string;
  mergedAt: string;
  leadHours: number;
  assistedBy: AssistedBy;
  isRevert: boolean;
  isHotfix: boolean;
  htmlUrl: string;
}

export interface OverviewRow {
  repo: string;
  status: SyncStatus;
  lastSyncedAt: string | null;
  mergedPrs: number;
  aiParticipationPct: number | null;
  df: MetricValue;
  lt: MetricValue;
  cfr: MetricValue;
  mttr: MetricValue;
}

const DATA_SOURCE = {
  deploymentDefinition: 'A PR merged to the default branch counts as one deployment.',
  notes: [
    'Lead time = first commit on the PR → merge (median). Coding = first commit → PR opened; review = PR opened → merge.',
    'Change failures = PRs titled/labelled revert or hotfix (or on hotfix/patch branches) + issues labelled bug/incident.',
    'Time to restore = median of hotfix PR open→merge and incident issue open→close.',
    'AI-assisted = a Co-Authored-By AI trailer on any commit, a bot author, or a Claude Code / Kiro / Amazon Q / Copilot marker in the PR body.',
    'Incident issues cannot be attributed to a PR, so they count only in the "All" cohort.',
    'Tiers follow the DORA State of DevOps bands (Elite / High / Medium / Low).',
  ],
};

export const toSummary = (r: RepoItem): RepoSummary => ({
  repo: r.repo,
  owner: r.owner,
  name: r.name,
  defaultBranch: r.defaultBranch,
  addedBy: r.addedBy,
  addedAt: r.addedAt,
  lastSyncedAt: r.lastSyncedAt ?? null,
  status: r.lastSyncStatus,
  ...(r.lastSyncError ? { error: r.lastSyncError } : {}),
  prCount: r.prCount ?? 0,
  incidentCount: r.incidentCount ?? 0,
});

export function parseWindow(raw: string | undefined): number | null {
  if (raw == null || raw === '') return 30;
  const n = Number(raw);
  return (WINDOWS as readonly number[]).includes(n) ? n : null;
}

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    getTenantId(event); // auth parity with every other route: a valid tenant-scoped token is required
    const route = `${event.httpMethod} ${event.resource}`;
    switch (route) {
      case 'GET /v1/dora/repos': return listRepos(event);
      case 'POST /v1/dora/repos': return addRepo(event);
      case 'DELETE /v1/dora/repos/{owner}/{name}': return deleteRepo(event);
      case 'POST /v1/dora/repos/{owner}/{name}/sync': return syncRepo(event);
      case 'GET /v1/dora/metrics': return metrics(event);
      case 'GET /v1/dora/projects': return projectRows(event);
      case 'GET /v1/dora/overview': return overview(event);
      default: return notFound(`Unknown route ${route}`);
    }
  } catch (err) {
    console.error(err);
    return serverError();
  }
};

async function listRepos(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const [repos, token] = await Promise.all([store.listRepos(), loadGithubToken()]);
  return ok({ repos: repos.map(toSummary), tokenConfigured: !!token, isAdmin: isAdmin(event) });
}

async function addRepo(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  if (!isAdmin(event)) return forbidden('Only members of the admin group can add repositories.');
  let body: { repo?: unknown } = {};
  try { body = JSON.parse(event.body ?? '{}'); } catch { return badRequest('Body must be JSON'); }
  const repo = String(body.repo ?? '').trim().replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/, '').replace(/\/+$/, '');
  if (!REPO_RE.test(repo)) return badRequest('repo must look like "owner/name"');

  // Confirm the repo exists (and learn its default branch) when a token is available.
  let gh: GhRepo | { full_name: string; default_branch?: string } = { full_name: repo };
  const token = await loadGithubToken();
  if (token) {
    try {
      gh = (await createGithubClient(token).getJson<GhRepo>(`/repos/${repo}`)).data;
    } catch (err) {
      if (err instanceof GithubHttpError && err.status === 404) return badRequest(`Repository ${repo} was not found on GitHub`);
      console.warn('dora: repo lookup failed, registering anyway', (err as Error).message);
    }
  }

  const email = String(event.requestContext.authorizer?.claims?.email ?? 'admin');
  const item = newRepoItem(gh, email);
  const wasCreated = await store.createRepoIfAbsent(item);
  if (!wasCreated) return badRequest(`${item.repo} is already tracked`);
  await invokeCollector(item.repo);
  return created({ repo: toSummary(item) });
}

function repoFromPath(event: APIGatewayProxyEvent): string | null {
  const owner = event.pathParameters?.owner;
  const name = event.pathParameters?.name;
  if (!owner || !name) return null;
  const repo = `${decodeURIComponent(owner)}/${decodeURIComponent(name)}`;
  return REPO_RE.test(repo) ? repo : null;
}

async function deleteRepo(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  if (!isAdmin(event)) return forbidden('Only members of the admin group can remove repositories.');
  const repo = repoFromPath(event);
  if (!repo) return badRequest('Invalid repo path');
  if (!(await store.getRepo(repo))) return notFound(`${repo} is not tracked`);
  const items = await store.deleteRepoCascade(repo);
  return ok({ deleted: true, repo, items });
}

async function syncRepo(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  if (!isAdmin(event)) return forbidden('Only members of the admin group can trigger a sync.');
  const repo = repoFromPath(event);
  if (!repo) return badRequest('Invalid repo path');
  const existing = await store.getRepo(repo);
  if (!existing) return notFound(`${repo} is not tracked`);
  await store.updateRepoSync(existing.repo, { lastSyncStatus: 'pending', lastSyncError: null });
  await invokeCollector(existing.repo);
  return accepted({ repo: existing.repo, status: 'pending' });
}

async function invokeCollector(repo: string): Promise<void> {
  if (!COLLECTOR) { console.warn('dora: DORA_COLLECTOR_FUNCTION_NAME not set; skipping sync kick'); return; }
  await lambdaClient.send(new InvokeCommand({
    FunctionName: COLLECTOR,
    InvocationType: 'Event',
    Payload: Buffer.from(JSON.stringify({ repo })),
  }));
}

async function computeFor(repo: RepoItem, windowDays: number, now: Date): Promise<{ metrics: DoraMetrics; prs: PrItem[] }> {
  const fromIso = new Date(now.getTime() - windowDays * DAY).toISOString();
  const [prs, issues] = await Promise.all([store.queryPrs(repo.repo, fromIso), store.queryIssues(repo.repo, fromIso)]);
  return { metrics: computeDora(prs, issues, { windowDays, now }), prs };
}

async function metrics(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const q = event.queryStringParameters ?? {};
  const windowDays = parseWindow(q.window ?? undefined);
  if (windowDays == null) return badRequest(`window must be one of ${WINDOWS.join(', ')}`);
  const repoParam = (q.repo ?? '').trim();
  if (!REPO_RE.test(repoParam)) return badRequest('repo query parameter must look like "owner/name"');
  const repo = await store.getRepo(repoParam);
  if (!repo) return notFound(`${repoParam} is not tracked`);

  const now = new Date();
  const { metrics: m, prs } = await computeFor(repo, windowDays, now);
  const recentPrs: PrRow[] = [...prs]
    .sort((a, b) => b.mergedAt.localeCompare(a.mergedAt))
    .slice(0, 25)
    .map((p) => ({
      number: p.number,
      title: p.title,
      author: p.author,
      mergedAt: p.mergedAt,
      leadHours: Math.round(Math.max(0, (new Date(p.mergedAt).getTime() - new Date(p.firstCommitAt).getTime()) / 3_600_000) * 10) / 10,
      assistedBy: p.assistedBy,
      isRevert: p.isRevert,
      isHotfix: p.isHotfix,
      htmlUrl: p.htmlUrl,
    }));
  return ok({ repo: toSummary(repo), window: windowDays, metrics: m, recentPrs, dataSource: DATA_SOURCE });
}

/**
 * GET /v1/dora/projects — Delivery × Cost per registry project (#13): DORA metrics pooled
 * across the project's repos (same computeDora as everywhere else) + windowed token cost from
 * the PROJDAY daily rollups, priced per model with the shared rate card.
 */
async function projectRows(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const windowDays = parseWindow(event.queryStringParameters?.window ?? undefined);
  if (windowDays == null) return badRequest(`window must be one of ${WINDOWS.join(', ')}`);
  const tenantId = getTenantId(event);
  const now = new Date();

  const [projects, doraRepos] = await Promise.all([projectRegistry.listProjects(), store.listRepos()]);
  const tracked = new Set(doraRepos.map((r) => r.sk));

  const fromIso = new Date(now.getTime() - windowDays * DAY).toISOString();
  const wantedRepos = [...new Set(projects.flatMap((p) => p.repos))].filter((r) => tracked.has(r));
  const prsByRepo = new Map<string, Awaited<ReturnType<typeof store.queryPrs>>>();
  const issuesByRepo = new Map<string, Awaited<ReturnType<typeof store.queryIssues>>>();
  await Promise.all(wantedRepos.map(async (r) => {
    const [prs, issues] = await Promise.all([store.queryPrs(r, fromIso), store.queryIssues(r, fromIso)]);
    prsByRepo.set(r, prs);
    issuesByRepo.set(r, issues);
  }));

  const projday = await queryProjday(tenantId, now, windowDays);
  const rows: DoraProjectRow[] = buildProjectRows(projects, prsByRepo, issuesByRepo, projday, {
    windowDays, now, doraTrackedRepos: tracked,
  });
  return ok({ window: windowDays, projects: rows, dataSource: DATA_SOURCE });
}

async function queryProjday(tenantId: string, now: Date, windowDays: number): Promise<ProjdayItem[]> {
  const { fromSk, toSk } = projdayRange(now, windowDays);
  const out: ProjdayItem[] = [];
  let key: Record<string, unknown> | undefined;
  do {
    const res = await ddbAgg.send(new QueryCommand({
      TableName: AGGREGATES_TABLE,
      KeyConditionExpression: 'pk = :pk AND sk BETWEEN :from AND :to',
      ExpressionAttributeValues: { ':pk': `TENANT#${tenantId}#PROJDAY`, ':from': fromSk, ':to': toSk },
      ExclusiveStartKey: key,
    }));
    for (const it of (res.Items ?? []) as Record<string, unknown>[]) {
      out.push({
        day: String(it.day ?? ''),
        projectId: String(it.projectId ?? 'untagged'),
        modelId: String(it.modelId ?? ''),
        inputTokens: Number(it.inputTokens ?? 0),
        outputTokens: Number(it.outputTokens ?? 0),
        cacheReadTokens: Number(it.cacheReadTokens ?? 0),
        invocations: Number(it.invocations ?? 0),
      });
    }
    key = res.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (key);
  return out;
}

async function overview(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const windowDays = parseWindow(event.queryStringParameters?.window ?? undefined);
  if (windowDays == null) return badRequest(`window must be one of ${WINDOWS.join(', ')}`);
  const now = new Date();
  const repos = await store.listRepos();
  const rows: OverviewRow[] = await Promise.all(repos.map(async (r) => {
    const { metrics: m } = await computeFor(r, windowDays, now);
    const pick = (v: MetricValue): MetricValue => ({ value: v.value, tier: v.tier, n: v.n });
    return {
      repo: r.repo,
      status: r.lastSyncStatus,
      lastSyncedAt: r.lastSyncedAt ?? null,
      mergedPrs: m.sample.mergedPrs,
      aiParticipationPct: m.aiParticipationPct,
      df: pick(m.deploymentFrequency.all),
      lt: pick(m.leadTime.all),
      cfr: pick(m.changeFailureRate.all),
      mttr: pick(m.mttr.all),
    };
  }));
  return ok({ window: windowDays, repos: rows, dataSource: DATA_SOURCE });
}
