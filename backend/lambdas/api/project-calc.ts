/**
 * Pure assembly of the per-project Delivery × Cost rows (#13) — no AWS calls, fully
 * unit-testable. DORA metrics are computed by POOLING each project's repos' PRs/issues through
 * the same computeDora used everywhere else, so per-repo and per-project numbers can never
 * disagree. Cost comes from PROJDAY daily rollups priced per model with the shared rate card.
 */
import { computeDora, MetricValue } from '../dora/dora-calc';
import { IssueForMetrics, PrForMetrics } from '../dora/types';
import { ModelRate, RATE_CARD, computeModelCost, normalizeModelId } from './cost-calc';
import { RegistryProject } from '../shared/project-registry';

export interface ProjdayItem {
  day: string;
  projectId: string;
  modelId: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  invocations: number;
}

export interface DoraProjectRow {
  projectId: string;
  name: string;
  costCenter: string | null;
  repos: string[];
  dora: {
    /** `band` is DORA's ordinal phrase for the rate; surfaces lead with it, not with `value`. */
    df: MetricValue & { band: string | null };
    lt: MetricValue;
    cfr: MetricValue;
    mttr: MetricValue;
    aiParticipationPct: number | null;
    mergedPrs: number;
  } | null;
  tokens: number;
  estimatedUsd: number;
  usdPerDeployment: number | null;
  usdPerMergedPr: number | null;
  notes: string[];
}

/** sk range for a PROJDAY window query: sk BETWEEN <fromDay> AND <toDay>#￿. */
export function projdayRange(now: Date, windowDays: number): { fromSk: string; toSk: string; fromDay: string; toDay: string } {
  const DAY = 86_400_000;
  const toDay = now.toISOString().slice(0, 10);
  const fromDay = new Date(now.getTime() - Math.max(1, Math.floor(windowDays)) * DAY).toISOString().slice(0, 10);
  return { fromSk: fromDay, toSk: `${toDay}#￿`, fromDay, toDay };
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

export interface BuildOptions {
  windowDays: number;
  now: Date;
  /** Repos present in the DORA registry ("owner/name" lowercase) — used for the note. */
  doraTrackedRepos: Set<string>;
  card?: ModelRate[];
}

/**
 * Build one Delivery × Cost row per registry project.
 * - prsByRepo / issuesByRepo: window-filtered items per repo (only for tracked repos).
 * - projdayItems: PROJDAY rows already limited to the window by the sk range query.
 */
export function buildProjectRows(
  projects: readonly RegistryProject[],
  prsByRepo: ReadonlyMap<string, PrForMetrics[]>,
  issuesByRepo: ReadonlyMap<string, IssueForMetrics[]>,
  projdayItems: readonly ProjdayItem[],
  opts: BuildOptions,
): DoraProjectRow[] {
  const card = opts.card ?? RATE_CARD;

  // Cost per project: sum PROJDAY rows per (project, model), price per model.
  const costByProject = new Map<string, { tokens: number; usd: number }>();
  for (const it of projdayItems) {
    const e = costByProject.get(it.projectId) ?? { tokens: 0, usd: 0 };
    e.tokens += (it.inputTokens ?? 0) + (it.outputTokens ?? 0);
    e.usd += computeModelCost({
      modelId: normalizeModelId(it.modelId),
      inputTokens: it.inputTokens,
      outputTokens: it.outputTokens,
      cacheReadTokens: it.cacheReadTokens,
    }, card).estimatedUsd;
    costByProject.set(it.projectId, e);
  }

  return projects.map((p) => {
    const notes: string[] = [];
    const tracked = p.repos.filter((r) => opts.doraTrackedRepos.has(r));
    for (const r of p.repos) {
      if (!opts.doraTrackedRepos.has(r)) notes.push(`repo ${r} is not tracked in DORA`);
    }

    let dora: DoraProjectRow['dora'] = null;
    if (tracked.length > 0) {
      const pooledPrs = tracked.flatMap((r) => prsByRepo.get(r) ?? []);
      const pooledIssues = tracked.flatMap((r) => issuesByRepo.get(r) ?? []);
      const m = computeDora(pooledPrs, pooledIssues, { windowDays: opts.windowDays, now: opts.now });
      const pick = (v: MetricValue): MetricValue => ({ value: v.value, tier: v.tier, n: v.n });
      dora = {
        df: { ...pick(m.deploymentFrequency.all), band: m.deploymentFrequency.all.band },
        lt: pick(m.leadTime.all),
        cfr: pick(m.changeFailRate.all),
        mttr: pick(m.mttr.all),
        aiParticipationPct: m.aiParticipationPct,
        mergedPrs: m.sample.mergedPrs,
      };
    } else if (p.repos.length === 0) {
      notes.push('no repos linked — cost only');
    }

    const cost = costByProject.get(p.projectId) ?? { tokens: 0, usd: 0 };
    if (cost.tokens === 0) notes.push('no usage recorded in window');
    const mergedPrs = dora?.mergedPrs ?? 0;
    const perPr = mergedPrs > 0 ? round2(cost.usd / mergedPrs) : null;

    return {
      projectId: p.projectId,
      name: p.name,
      costCenter: p.costCenter ?? null,
      repos: p.repos,
      dora,
      tokens: cost.tokens,
      estimatedUsd: round6(cost.usd),
      // Deployment := PR merged to the default branch, so the two are equal today; both are
      // exposed so they can diverge if a formal deployment signal is added later.
      usdPerDeployment: perPr,
      usdPerMergedPr: perPr,
      notes,
    };
  });
}
