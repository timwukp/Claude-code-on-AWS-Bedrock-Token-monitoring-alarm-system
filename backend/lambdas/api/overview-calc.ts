/**
 * Overview arithmetic (feature-22) — pure, over the daily per-project × model rollups (PROJDAY).
 *
 * The landing page needs three things no existing endpoint gives: spend for a period AND the prior
 * equal-length period (so a delta can be honest about what it compares), a daily series for a
 * sparkline, and per-project movers. All three are one PROJDAY range read priced with the same rate
 * card the Cost page uses, so the Overview reconciles with Cost and Projects by construction.
 */
import { ModelRate, RATE_CARD, computeModelCost } from './cost-calc';
import { ProjdayItem } from './project-calc';

export type WindowKind = '7' | '30' | '90' | 'mtd';

export interface WindowBounds {
  kind: WindowKind;
  days: number;
  /** Inclusive day strings (YYYY-MM-DD), UTC. */
  from: string; to: string; priorFrom: string; priorTo: string;
}

const DAY = 86_400_000;
const dayStr = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * DAY);

/**
 * Current period = the last `days` calendar days ending today (UTC); prior = the `days` before that.
 * MTD: from the 1st of the month to today; prior = the same number of elapsed days in the previous
 * month, ending on its matching day (so "Sept 1–18" compares with "Aug 1–18", never a whole month).
 */
export function windowBounds(now: Date, kind: WindowKind): WindowBounds {
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  if (kind === 'mtd') {
    const first = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
    const elapsed = today.getUTCDate(); // 1..31 → days including today
    const prevFirst = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 1, 1));
    const prevLen = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 0)).getUTCDate();
    const prevEnd = addDays(prevFirst, Math.min(elapsed, prevLen) - 1);
    return { kind, days: elapsed, from: dayStr(first), to: dayStr(today), priorFrom: dayStr(prevFirst), priorTo: dayStr(prevEnd) };
  }
  const days = Number(kind);
  const from = addDays(today, -(days - 1));
  const priorTo = addDays(from, -1);
  const priorFrom = addDays(priorTo, -(days - 1));
  return { kind, days, from: dayStr(from), to: dayStr(today), priorFrom: dayStr(priorFrom), priorTo: dayStr(priorTo) };
}

export interface OverviewSpend {
  currentUsd: number; priorUsd: number; deltaUsd: number; deltaPct: number | null;
  tokens: number; priorTokens: number;
  daily: { day: string; usd: number; tokens: number }[];
}
export interface OverviewModelRow {
  modelId: string; inputTokens: number; outputTokens: number; cacheReadTokens: number; invocations: number; estimatedUsd: number;
}
export interface OverviewMover {
  projectId: string; name: string | null; currentUsd: number; priorUsd: number; deltaUsd: number; deltaPct: number | null;
}
export interface OverviewResult {
  window: WindowBounds;
  spend: OverviewSpend;
  byModel: OverviewModelRow[];
  movers: OverviewMover[];
  coverage: { firstDayWithData: string | null; partial: boolean };
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const pct = (cur: number, prior: number): number | null => (prior > 0 ? round2(((cur - prior) / prior) * 100) : null);

function priceOf(it: ProjdayItem, card: ModelRate[]): number {
  return computeModelCost({ modelId: it.modelId, inputTokens: it.inputTokens, outputTokens: it.outputTokens, cacheReadTokens: it.cacheReadTokens }, card).estimatedUsd;
}
const tokensOf = (it: ProjdayItem) => it.inputTokens + it.outputTokens + it.cacheReadTokens;

export function buildOverview(
  items: readonly ProjdayItem[],
  bounds: WindowBounds,
  names: ReadonlyMap<string, string> = new Map(),
  card: ModelRate[] = RATE_CARD,
  topMovers = 8,
): OverviewResult {
  const inCur = (d: string) => d >= bounds.from && d <= bounds.to;
  const inPrior = (d: string) => d >= bounds.priorFrom && d <= bounds.priorTo;

  let currentUsd = 0, priorUsd = 0, tokens = 0, priorTokens = 0;
  const daily = new Map<string, { usd: number; tokens: number }>();
  const byModel = new Map<string, OverviewModelRow>();
  const proj = new Map<string, { cur: number; prior: number }>();
  let firstDay: string | null = null;

  for (const it of items) {
    if (!it.day) continue;
    if (firstDay === null || it.day < firstDay) firstDay = it.day;
    const usd = priceOf(it, card);
    const tok = tokensOf(it);
    const p = proj.get(it.projectId) ?? { cur: 0, prior: 0 };
    if (inCur(it.day)) {
      currentUsd += usd; tokens += tok; p.cur += usd;
      const d = daily.get(it.day) ?? { usd: 0, tokens: 0 };
      d.usd += usd; d.tokens += tok; daily.set(it.day, d);
      const m = byModel.get(it.modelId) ?? { modelId: it.modelId, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, invocations: 0, estimatedUsd: 0 };
      m.inputTokens += it.inputTokens; m.outputTokens += it.outputTokens; m.cacheReadTokens += it.cacheReadTokens;
      m.invocations += it.invocations; m.estimatedUsd += usd; byModel.set(it.modelId, m);
    } else if (inPrior(it.day)) {
      priorUsd += usd; priorTokens += tok; p.prior += usd;
    } else continue;
    proj.set(it.projectId, p);
  }

  // Every day in the current window appears in the series, zero-filled, so a sparkline has a stable x.
  const series: OverviewSpend['daily'] = [];
  for (let d = new Date(bounds.from + 'T00:00:00Z'); dayStr(d) <= bounds.to; d = addDays(d, 1)) {
    const k = dayStr(d); const v = daily.get(k);
    series.push({ day: k, usd: round2(v?.usd ?? 0), tokens: v?.tokens ?? 0 });
  }

  const movers: OverviewMover[] = [...proj.entries()]
    .map(([projectId, v]) => ({
      projectId, name: names.get(projectId) ?? null,
      currentUsd: round2(v.cur), priorUsd: round2(v.prior), deltaUsd: round2(v.cur - v.prior), deltaPct: pct(v.cur, v.prior),
    }))
    .filter((m) => m.currentUsd > 0 || m.priorUsd > 0)
    .sort((a, b) => Math.abs(b.deltaUsd) - Math.abs(a.deltaUsd))
    .slice(0, topMovers);

  return {
    window: bounds,
    spend: {
      currentUsd: round2(currentUsd), priorUsd: round2(priorUsd), deltaUsd: round2(currentUsd - priorUsd),
      deltaPct: pct(currentUsd, priorUsd), tokens, priorTokens, daily: series,
    },
    byModel: [...byModel.values()].map((m) => ({ ...m, estimatedUsd: round2(m.estimatedUsd) })).sort((a, b) => b.estimatedUsd - a.estimatedUsd),
    movers,
    // Partial when the earliest rollup day is inside the prior window — the comparison is then
    // against an incomplete baseline and the page must say so rather than show a clean delta.
    coverage: { firstDayWithData: firstDay, partial: firstDay === null || firstDay > bounds.priorFrom },
  };
}
