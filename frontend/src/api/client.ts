import { getIdToken } from '../auth/cognito';

const BASE = import.meta.env.VITE_API_URL as string;

/** Thin fetch wrapper that attaches the Cognito JWT and parses JSON. */
async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = await getIdToken();
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: token } : {}),
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) {
    // Surface the server's { error } message when present (e.g. 400 validation, 403 forbidden).
    let detail = '';
    try { detail = ((await res.json()) as { error?: string }).error ?? ''; } catch { /* non-JSON body */ }
    throw new Error(`API ${path} failed: ${res.status}${detail ? ` — ${detail}` : ''}`);
  }
  return res.json() as Promise<T>;
}

export interface UsagePoint {
  timestamp: string;
  inputTokens: number;
  outputTokens: number;
  /** Prompt-cache reads/writes — quota accounting counts these as input; billing does not. */
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  invocations: number;
  cost?: number; // estimated USD for this bucket (optional; older API responses omit it)
  label?: string; // short HH:MM label for chart axis (set client-side)
}

// ---- DORA metrics (GET/POST /v1/dora/*) — shapes mirror backend/lambdas/api/dora.ts ----
export type Tier = 'Elite' | 'High' | 'Medium' | 'Low' | 'Unknown';
export type AssistedBy = 'claude-code' | 'kiro' | 'amazon-q' | 'copilot' | null;
export type SyncStatus = 'pending' | 'syncing' | 'ok' | 'rate-limited' | 'token-not-configured' | 'error';
export interface MetricValue { value: number | null; tier: Tier; n: number }
export interface Split<T> { all: T; ai: T; human: T }
export interface DoraMetrics {
  deploymentFrequency: Split<MetricValue & { perDay: number | null; deployments: number }>;
  leadTime: Split<MetricValue & { p95: number | null; mean: number | null; codingHours: number | null; reviewHours: number | null }>;
  changeFailureRate: Split<MetricValue & { reverts: number; hotfixes: number; incidents: number; failures: number }>;
  mttr: Split<MetricValue>;
  aiParticipationPct: number | null;
  byAssistant: Record<Exclude<AssistedBy, null>, number>;
  timeline: { week: string; weekStart: string; deploysAi: number; deploysHuman: number; medianLeadHours: number | null; failures: number }[];
  sample: { mergedPrs: number; incidents: number; windowDays: number; from: string; to: string };
}
export interface DoraRepo {
  repo: string; owner: string; name: string; defaultBranch: string; addedBy: string; addedAt: string;
  lastSyncedAt: string | null; status: SyncStatus; error?: string; prCount: number; incidentCount: number;
}
export interface DoraPrRow {
  number: number; title: string; author: string; mergedAt: string; leadHours: number;
  assistedBy: AssistedBy; isRevert: boolean; isHotfix: boolean; htmlUrl: string;
}
export interface DoraOverviewRow {
  repo: string; status: SyncStatus; lastSyncedAt: string | null; mergedPrs: number; aiParticipationPct: number | null;
  df: MetricValue; lt: MetricValue; cfr: MetricValue; mttr: MetricValue;
}
export interface DoraDataSource { deploymentDefinition: string; notes: string[] }
export type DoraWindow = 7 | 30 | 90;

const repoPath = (repo: string) => repo.split('/').map(encodeURIComponent).join('/');

export const api = {
  doraRepos: () => request<{ repos: DoraRepo[]; tokenConfigured: boolean; isAdmin: boolean }>('v1/dora/repos'),
  doraAddRepo: (repo: string) =>
    request<{ repo: DoraRepo }>('v1/dora/repos', { method: 'POST', body: JSON.stringify({ repo }) }),
  doraDeleteRepo: (repo: string) =>
    request<{ deleted: boolean; items: number }>(`v1/dora/repos/${repoPath(repo)}`, { method: 'DELETE' }),
  doraSyncRepo: (repo: string) =>
    request<{ repo: string; status: SyncStatus }>(`v1/dora/repos/${repoPath(repo)}/sync`, { method: 'POST' }),
  doraMetrics: (repo: string, window: DoraWindow) =>
    request<{ repo: DoraRepo; window: number; metrics: DoraMetrics; recentPrs: DoraPrRow[]; dataSource: DoraDataSource }>(
      `v1/dora/metrics?repo=${encodeURIComponent(repo)}&window=${window}`,
    ),
  doraOverview: (window: DoraWindow) =>
    request<{ window: number; repos: DoraOverviewRow[]; dataSource: DoraDataSource }>(`v1/dora/overview?window=${window}`),
  usage: (from?: string, to?: string) =>
    request<{ points: UsagePoint[] }>(
      `v1/usage${from || to ? `?from=${from ?? ''}&to=${to ?? ''}` : ''}`,
    ),
  costs: () => request<{ byModel: any[]; totalEstimatedUsd: number }>('v1/costs'),
  anomalies: () => request<{ anomalies: any[] }>('v1/anomalies'),
  // source 'fast' reads pre-aggregated rollups from DynamoDB (quick, project_id codes);
  // 'full' runs the Athena join for human-readable project names + cost centers.
  projects: (source: 'fast' | 'full' = 'fast') =>
    request<{ projects: any[]; source?: string; totalTokens?: number | string; totalEstimatedUsd?: number }>(`v1/projects${source === 'fast' ? '?source=fast' : ''}`),
  quotas: () => request<{ throttles: { throttledCount: number; clientErrors: number; throttled: boolean }; headroom: any[] }>('v1/quotas'),
  governance: () => request<{ budget: any; enforcement: any }>('v1/governance'),
  startQuery: (template: string, days: number) =>
    request<{ id: string }>('v1/queries', { method: 'POST', body: JSON.stringify({ template, days }) }),
  pollQuery: (id: string) => request<{ id: string; state: string; rows?: any[] }>(`v1/queries/${id}`),
};
