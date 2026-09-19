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
/** Deployment frequency also carries DORA's ordinal phrase for the rate; surfaces lead with it. */
export interface DeployFreqValue extends MetricValue { band: string | null }
export interface Split<T> { all: T; ai: T; human: T }
export interface DoraMetrics {
  deploymentFrequency: Split<DeployFreqValue & { perDay: number | null; deployments: number }>;
  leadTime: Split<MetricValue & { p95: number | null; mean: number | null; codingHours: number | null; reviewHours: number | null }>;
  changeFailRate: Split<MetricValue & { reverts: number; hotfixes: number; incidents: number; failures: number }>;
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
  df: DeployFreqValue; lt: MetricValue; cfr: MetricValue; mttr: MetricValue;
}
export interface BandReference {
  metric: 'df' | 'lt' | 'mttr';
  /** DORA's own label for the metric these bands were published against. */
  label: string;
  bands: { tier: Exclude<Tier, 'Unknown'>; text: string }[];
}
export interface DoraDataSource {
  deploymentDefinition: string;
  notes: string[];
  /** The single dora.dev surface our labels come from, cited by URL. */
  canonicalSource?: string;
  /** Published 2024 change-fail-rate values, shown as reference marks since no tier is derivable. */
  cfrReference?: { tier: Exclude<Tier, 'Unknown'>; pct: number }[];
  /** The 2024 bands in words, for the definitions disclosure. Never includes change fail rate. */
  bandReference?: BandReference[];
}
// ---- ROI (#14) — mirrors backend/lambdas/api/roi-calc.ts + roi.ts ----
export interface RoiComponent { valueUsd: number; formulaInputs: Record<string, number | string | null>; note: string }
export interface Bands { p25: number; p50: number; p90: number }
export interface WeeklyPoint { weekStart: string; value: number }
export interface RoiResult {
  window: number; annualizationFactor: number;
  value: { timeSaved: RoiComponent; throughput: RoiComponent; stabilityDelta: RoiComponent; totalUsd: number };
  investment: { aiSpend: RoiComponent; training: RoiComponent; jCurve: RoiComponent; totalUsd: number };
  roiPct: number | null; paybackMonths: number | null;
  breakEven: { hoursPerMonth: number | null; pctOfCapacity: number | null; verdict: 'within-rct-bracket' | 'above-rct-bracket' | 'unknown' };
  unitEconomics: { usdPerMergedPr: number | null; usdPerDeployment: number | null; tokensPerMergedPr: WeeklyPoint[] };
  uncertainty: { bracketLowPct: number; bracketHighPct: number; appliedTo: string; note: string };
  refusals: string[]; notes: string[];
}
export interface RoiProjectRow {
  projectId: string; name: string; category: string | null;
  assumptionsSource: 'project' | 'org-default' | 'code-default';
  roi: RoiResult;
  bands: { usdPerPr: Bands | null; weeklyUsd: Bands | null; weeks: number };
  killFast: { flagged: boolean; weeks: string[]; rule: string };
  monthlySpendUsd: number; mergedPrs: number;
}
export interface RoiMethodology { framing: string; bracket: { lowPct: number; highPct: number }; refuses: string[]; annualization: string }
export type ProjectRoiConfig = Record<string, unknown>;
export type DoraWindow = 7 | 30 | 90;
export interface RegistryProject {
  projectId: string; name: string; costCenter: string | null; repos: string[];
  identityArns: string[]; addedBy: string; addedAt: string; seeded: boolean;
  roi?: ProjectRoiConfig | null;
}
export interface DoraProjectRow {
  projectId: string; name: string; costCenter: string | null; repos: string[];
  dora: { df: DeployFreqValue; lt: MetricValue; cfr: MetricValue; mttr: MetricValue;
          aiParticipationPct: number | null; mergedPrs: number } | null;
  tokens: number; estimatedUsd: number;
  usdPerDeployment: number | null; usdPerMergedPr: number | null; notes: string[];
}

/** Windows the latency endpoint accepts. Narrower than `Window`: annualising is not the question
 *  here, and CloudWatch's percentile buckets get coarse well before 90 days. */
export type LatencyWindow = 1 | 7 | 30;
export interface LatencyStat {
  p50: number | null; p95: number | null; p99: number | null; samples: number | null;
  /** Percentile is a sample-weighted mean of several CloudWatch buckets, not exact for the window. */
  approximated?: true;
  /** Computed as e2e − ttft. Percentiles are not additive, so this is indicative only. */
  derived?: true;
}
export interface LatencyRow {
  modelId: string;
  label: string;
  /** Set when `modelId` was an application inference profile id, not a model id. */
  via?: 'inference-profile';
  profileName?: string;
  /** Absent when the profile fans out to several models — the API refuses to pick one. */
  resolvedModel?: string;
  e2e: LatencyStat;
  ttft: LatencyStat;
  generation: LatencyStat;
}
export interface LatencyHop {
  id: string; label: string; status: 'measured' | 'unmeasured';
  metric?: 'ttft' | 'generation'; note: string; instrument?: string;
}
export interface LatencyResponse {
  window: number; generatedAt: string; source: string; scope: string; scopeNote: string;
  fleet: { e2e: LatencyStat; ttft: LatencyStat; generation: LatencyStat };
  models: LatencyRow[]; hops: LatencyHop[];
  coverage: { e2eSamples: number | null; ttftSamples: number | null; streamingPct: number | null; note: string };
  percentileNote: string; caveat: string;
}

const repoPath = (repo: string) => repo.split('/').map(encodeURIComponent).join('/');


export type OverviewWindow = 7 | 30 | 90 | 'mtd';
export interface OverviewResponse {
  tenantId: string;
  window: { kind: '7' | '30' | '90' | 'mtd'; days: number; from: string; to: string; priorFrom: string; priorTo: string };
  spend: { currentUsd: number; priorUsd: number; deltaUsd: number; deltaPct: number | null; tokens: number; priorTokens: number; daily: { day: string; usd: number; tokens: number }[] };
  byModel: { modelId: string; inputTokens: number; outputTokens: number; cacheReadTokens: number; invocations: number; estimatedUsd: number }[];
  movers: { projectId: string; name: string | null; currentUsd: number; priorUsd: number; deltaUsd: number; deltaPct: number | null }[];
  coverage: { firstDayWithData: string | null; partial: boolean };
  rollupsAsOf: string | null;
}
export interface GovernanceBudget {
  name?: string; limitUsd: number; actualUsd: number; forecastedUsd: number; timeUnit?: string;
  actualPct?: number; forecastedPct?: number; billingDataAvailable?: boolean; forecastAvailable?: boolean; error?: string;
}

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
  doraProjects: (window: DoraWindow) =>
    request<{ window: number; projects: DoraProjectRow[]; dataSource: DoraDataSource }>(`v1/dora/projects?window=${window}`),
  projectRegistry: () =>
    request<{ projects: RegistryProject[]; profiles: { arn: string; projectId: string; underlyingModelId: string; profileName: string | null }[]; isAdmin: boolean }>('v1/projects/registry'),
  projectRegistryUpsert: (p: { id: string; name: string; costCenter?: string; repos?: string[]; identityArns?: string[]; roi?: ProjectRoiConfig }) =>
    request<{ project: RegistryProject }>('v1/projects/registry', { method: 'POST', body: JSON.stringify(p) }),
  projectRegistryDelete: (id: string) =>
    request<{ deleted: boolean; items: number }>(`v1/projects/registry/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  roiProjects: (window: 30 | 90) =>
    request<{ window: number; projects: RoiProjectRow[]; orgDefaults: ProjectRoiConfig; isAdmin: boolean; methodology: RoiMethodology }>(`v1/roi/projects?window=${window}`),
  roiEstimate: (p: { reference: string; prsPerMonth: number; teamSize?: number; loadedCostPerYear?: number }) =>
    request<{ reference: { projectId: string; name: string }; prsPerMonth: number; teamSize: number; loadedCostPerYear: number;
      bands: { usdPerPr: Bands | null; weeklyUsd: Bands | null; weeks: number };
      budgetMonthlyUsd: Bands | null; projectedBreakEvenHoursPerMonth: Bands | null; pctOfCapacityP50: number | null; notes: string[];
      methodology: RoiMethodology }>(
      `v1/roi/estimate?reference=${encodeURIComponent(p.reference)}&prsPerMonth=${p.prsPerMonth}`
      + (p.teamSize != null ? `&teamSize=${p.teamSize}` : '') + (p.loadedCostPerYear != null ? `&loadedCostPerYear=${p.loadedCostPerYear}` : '')),
  roiDefaults: () => request<{ defaults: ProjectRoiConfig; isAdmin: boolean }>('v1/projects/registry/defaults'),
  roiDefaultsPut: (defaults: ProjectRoiConfig) =>
    request<{ defaults: ProjectRoiConfig }>('v1/projects/registry/defaults', { method: 'PUT', body: JSON.stringify({ defaults }) }),
  doraOverview: (window: DoraWindow) =>
    request<{ window: number; repos: DoraOverviewRow[]; dataSource: DoraDataSource }>(`v1/dora/overview?window=${window}`),
  latency: (window: LatencyWindow) => request<LatencyResponse>(`v1/latency?window=${window}`),
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
  governance: () => request<{ budget: GovernanceBudget | null; enforcement: any }>('v1/governance'),
  overview: (window: OverviewWindow) => request<OverviewResponse>(`v1/overview?window=${window}`),
  startQuery: (template: string, days: number) =>
    request<{ id: string }>('v1/queries', { method: 'POST', body: JSON.stringify({ template, days }) }),
  pollQuery: (id: string) => request<{ id: string; state: string; rows?: any[] }>(`v1/queries/${id}`),
};
