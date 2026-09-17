/**
 * Pure AI-coding ROI model (#14) — no AWS calls, fully unit-testable.
 *
 * The math is DORA's official AI ROI calculator (dora.dev/ai/roi), verified verbatim against
 * its published source and documented in docs/research-roi-model.md + docs/ROI_METHODOLOGY.md:
 *
 *   ROI = (Value − Investment) / Investment          Payback = Investment / annual Value
 *   Value      = time-saved + throughput + SIGNED stability delta
 *   Investment = actual AI spend (annualized) + training + J-curve (one-time, NOT annualized)
 *
 * Non-negotiable framing rules from the research (enforced structurally here):
 *  - net-time-saved has a −100% floor: the model admits AI can be net-negative.
 *  - the stability term is signed — DORA's own defaults assume CFR can WORSEN under AI.
 *  - no productivity multiplier is hard-coded; results carry the honest RCT bracket
 *    (−19% METR … +56% Peng) as metadata for the UI to display.
 *  - anything the inputs cannot support is REFUSED with an explicit note, never invented.
 *  - perception/survey numbers are not accepted anywhere in these inputs.
 */
import { ModelRate, RATE_CARD, computeModelCost, normalizeModelId } from './cost-calc';
import { ProjdayItem } from './project-calc';

export interface WeeklyPoint { weekStart: string; value: number } // ISO Monday (UTC)

export interface RoiAssumptions {
  teamSize: number;
  /** Canonical labor input (matches the DORA calculator); hourly = /2080. */
  loadedCostPerYear: number;
  /** Percent, floor −100 (verification tax can exceed the savings). Default 12.5 (DORA). */
  netTimeSavedPct: number;
  /** DORA convention: ~1/3 of shipped features increase revenue. */
  ideaSuccessRate: number;
  /** DORA convention: 0.01%–1% revenue impact per successful feature (fraction 0.0001–0.01). */
  revenueImpactPerFeature: number;
  /** Annual revenue base the throughput term draws on. 0 → throughput refused. */
  revenueBase: number;
  /** DORA default $100K/hr for a critical app. */
  downtimeCostPerHour: number;
  /** One-time, per user. */
  trainingCostPerUser: number;
  /** One-time adoption dip (DORA default 15% for 3 months). */
  jCurve: { include: boolean; dropPct: number; months: number };
  /** Explicit pre-AI baseline for the stability term; omitted → halves-split or refusal. */
  baseline?: { deploymentsPerYear: number; cfrPct: number; mttrHours: number };
  category?: 'product' | 'chore' | 'experiment';
}

export const ROI_DEFAULTS: RoiAssumptions = {
  teamSize: 1,
  loadedCostPerYear: 150_000,
  netTimeSavedPct: 12.5,
  ideaSuccessRate: 0.33,
  revenueImpactPerFeature: 0.005,
  revenueBase: 0,
  downtimeCostPerHour: 100_000,
  trainingCostPerUser: 0,
  jCurve: { include: false, dropPct: 15, months: 3 },
};

/** The honest experimental bracket for AI-coding speedup — displayed, never assumed. */
export const RCT_BRACKET = { lowPct: -19, highPct: 56 } as const;

export interface RoiWindowAggregates {
  windowDays: 30 | 90;
  spendUsd: number;
  tokens: number;
  mergedPrs: number;
  deployments: number;
  cfrPct: number | null;
  mttrHours: number | null;
  weeklySpendUsd: WeeklyPoint[];
  weeklyTokens: WeeklyPoint[];
  weeklyMergedPrs: WeeklyPoint[];
}

export interface RoiComponent {
  /** SIGNED — stabilityDelta (and totals) may be negative. */
  valueUsd: number;
  formulaInputs: Record<string, number | string | null>;
  note: string;
}

export interface RoiResult {
  window: number;
  /** 365/window — every rate-like term is annualized with this, disclosed to the UI. */
  annualizationFactor: number;
  value: { timeSaved: RoiComponent; throughput: RoiComponent; stabilityDelta: RoiComponent; totalUsd: number };
  investment: { aiSpend: RoiComponent; training: RoiComponent; jCurve: RoiComponent; totalUsd: number };
  roiPct: number | null;
  paybackMonths: number | null;
  breakEven: {
    hoursPerMonth: number | null;
    pctOfCapacity: number | null;
    verdict: 'within-rct-bracket' | 'above-rct-bracket' | 'unknown';
  };
  unitEconomics: {
    usdPerMergedPr: number | null;
    usdPerDeployment: number | null;
    /** Weekly tokens ÷ merged PRs — operational efficiency, explicitly NOT ROI. */
    tokensPerMergedPr: WeeklyPoint[];
  };
  uncertainty: { bracketLowPct: number; bracketHighPct: number; appliedTo: 'netTimeSavedPct'; note: string };
  /** What was NOT computed and why — honesty is a feature. */
  refusals: string[];
  notes: string[];
}

const HOURS_PER_YEAR = 2080;
const HOURS_PER_MONTH = HOURS_PER_YEAR / 12; // 173.33
const round0 = (n: number) => Math.round(n);
const round1 = (n: number) => Math.round(n * 10) / 10;
const round2 = (n: number) => Math.round(n * 100) / 100;
const clamp = (n: number, lo: number, hi: number) => Math.min(Math.max(n, lo), hi);

/** ISO Monday (UTC) for a timestamp/date string. */
function isoMonday(dateIso: string): string {
  const d = new Date(dateIso.slice(0, 10) + 'T00:00:00Z');
  const dayNum = d.getUTCDay() || 7;
  return new Date(d.getTime() - (dayNum - 1) * 86_400_000).toISOString().slice(0, 10);
}

/** Fold PROJDAY items into ISO-week spend/token series (per-model pricing via the rate card). */
export function weeklyFromProjday(
  items: readonly ProjdayItem[],
  card: ModelRate[] = RATE_CARD,
): { spend: WeeklyPoint[]; tokens: WeeklyPoint[] } {
  const spend = new Map<string, number>();
  const tokens = new Map<string, number>();
  for (const it of items) {
    const wk = isoMonday(it.day);
    const usd = computeModelCost({
      modelId: normalizeModelId(it.modelId),
      inputTokens: it.inputTokens,
      outputTokens: it.outputTokens,
      cacheReadTokens: it.cacheReadTokens,
    }, card).estimatedUsd;
    spend.set(wk, (spend.get(wk) ?? 0) + usd);
    tokens.set(wk, (tokens.get(wk) ?? 0) + (it.inputTokens ?? 0) + (it.outputTokens ?? 0));
  }
  const toSeries = (m: Map<string, number>): WeeklyPoint[] =>
    [...m.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([weekStart, value]) => ({ weekStart, value }));
  return { spend: toSeries(spend), tokens: toSeries(tokens) };
}

/**
 * Fallback stability baseline: split the window's weekly delivery into halves and use the first
 * half as "before". Only defensible when both halves carry ≥3 deployments — else null (refuse).
 */
export function baselineFromHalves(
  weeklyDeployments: readonly WeeklyPoint[],
  cfrFirstHalfPct: number | null,
  mttrFirstHalfHours: number | null,
  windowDays: number,
): { deploymentsPerYear: number; cfrPct: number; mttrHours: number } | null {
  if (weeklyDeployments.length < 4 || cfrFirstHalfPct == null || mttrFirstHalfHours == null) return null;
  const half = Math.floor(weeklyDeployments.length / 2);
  const first = weeklyDeployments.slice(0, half).reduce((t, w) => t + w.value, 0);
  const second = weeklyDeployments.slice(half).reduce((t, w) => t + w.value, 0);
  if (first < 3 || second < 3) return null;
  const halfDays = windowDays / 2;
  return { deploymentsPerYear: (first / halfDays) * 365, cfrPct: cfrFirstHalfPct, mttrHours: mttrFirstHalfHours };
}

/**
 * Was this project's own staffing configured? The value side is dominated by
 * teamSize × loadedCostPerYear, which is a property of THIS project's team. Falling back to a
 * code or org default silently claims one team's annual saving once per project, so the
 * portfolio total becomes a multiple of a placeholder. Without it the composite is refused.
 */
export interface RoiComputeOptions {
  readonly perProjectStaffing?: boolean;
}

export function computeRoi(agg: RoiWindowAggregates, a: RoiAssumptions, opts: RoiComputeOptions = {}): RoiResult {
  const refusals: string[] = [];
  const notes: string[] = [];
  const k = 365 / agg.windowDays;

  // ---- Value: time saved (floor −100%) -----------------------------------------------------
  const netPct = Math.max(a.netTimeSavedPct, -100);
  if (netPct !== a.netTimeSavedPct) notes.push('netTimeSavedPct clamped to the −100% floor');
  const timeSavedUsd = a.teamSize * a.loadedCostPerYear * (netPct / 100);
  const timeSaved: RoiComponent = {
    valueUsd: round0(timeSavedUsd),
    formulaInputs: { teamSize: a.teamSize, loadedCostPerYear: a.loadedCostPerYear, netTimeSavedPct: netPct },
    note: 'staff × loaded cost × net time saved (net of the verification tax; may be negative). '
      + 'An ASSUMPTION, not telemetry — see the RCT bracket.',
  };

  // ---- Value: throughput (refused without a revenue base AND a baseline) --------------------
  const revImpact = clamp(a.revenueImpactPerFeature, 0.0001, 0.01);
  if (revImpact !== a.revenueImpactPerFeature) notes.push('revenueImpactPerFeature clamped to [0.01%, 1%] (DORA convention)');
  let throughputUsd = 0;
  let deltaFeaturesPerYear: number | null = null;
  if (a.revenueBase <= 0) {
    refusals.push('Throughput value not computed: no revenue base configured — refusing to invent one.');
  } else if (!a.baseline) {
    refusals.push('Throughput value not computed: no pre-AI deployment baseline — Δfeatures/year is undefined.');
  } else {
    deltaFeaturesPerYear = agg.deployments * k - a.baseline.deploymentsPerYear;
    throughputUsd = deltaFeaturesPerYear * a.ideaSuccessRate * revImpact * a.revenueBase;
  }
  const throughput: RoiComponent = {
    valueUsd: round0(throughputUsd),
    formulaInputs: {
      deltaFeaturesPerYear: deltaFeaturesPerYear == null ? null : round1(deltaFeaturesPerYear),
      ideaSuccessRate: a.ideaSuccessRate, revenueImpactPerFeature: revImpact, revenueBase: a.revenueBase,
    },
    note: 'Δfeatures/yr × idea-success rate × revenue impact per feature × revenue base (DORA conservative conventions).',
  };

  // ---- Value: stability delta (SIGNED) ------------------------------------------------------
  let stabilityUsd = 0;
  let stabilityInputs: RoiComponent['formulaInputs'] = {};
  if (!a.baseline || agg.cfrPct == null || agg.mttrHours == null) {
    refusals.push('Stability delta not computed: needs a pre-AI baseline plus measured CFR and MTTR in the window.');
    stabilityInputs = { baseline: a.baseline ? 'partial' : null, cfrPct: agg.cfrPct, mttrHours: agg.mttrHours };
  } else {
    const costOf = (deploysPerYear: number, cfrPct: number, mttrHours: number) =>
      deploysPerYear * (cfrPct / 100) * mttrHours * a.downtimeCostPerHour;
    const baselineCost = costOf(a.baseline.deploymentsPerYear, a.baseline.cfrPct, a.baseline.mttrHours);
    const currentCost = costOf(agg.deployments * k, agg.cfrPct, agg.mttrHours);
    stabilityUsd = baselineCost - currentCost; // negative when stability WORSENED (a real cost)
    stabilityInputs = {
      baselineDowntimeUsdPerYear: round0(baselineCost), currentDowntimeUsdPerYear: round0(currentCost),
      downtimeCostPerHour: a.downtimeCostPerHour,
    };
  }
  const stabilityDelta: RoiComponent = {
    valueUsd: round0(stabilityUsd),
    formulaInputs: stabilityInputs,
    note: 'Signed: baseline downtime cost − current (deploys/yr × CFR × MTTR × $/hr). '
      + 'DORA’s own defaults assume CFR can worsen under AI — negative means a cost.',
  };

  // ---- Investment ---------------------------------------------------------------------------
  const aiSpendAnnual = agg.spendUsd * k;
  const aiSpend: RoiComponent = {
    valueUsd: round0(aiSpendAnnual),
    formulaInputs: { windowSpendUsd: round2(agg.spendUsd), annualizationFactor: round2(k) },
    note: 'MEASURED per-project AI spend (daily rollups × rate card), annualized from the window.',
  };
  const training: RoiComponent = {
    valueUsd: round0(a.trainingCostPerUser * a.teamSize),
    formulaInputs: { trainingCostPerUser: a.trainingCostPerUser, teamSize: a.teamSize },
    note: 'One-time — deliberately NOT annualized.',
  };
  const jCurveUsd = a.jCurve.include
    ? a.teamSize * a.loadedCostPerYear * (a.jCurve.dropPct / 100) * (a.jCurve.months / 12)
    : 0;
  const jCurve: RoiComponent = {
    valueUsd: round0(jCurveUsd),
    formulaInputs: { include: String(a.jCurve.include), dropPct: a.jCurve.dropPct, months: a.jCurve.months },
    note: 'One-time adoption dip (DORA default 15% for 3 months) — NOT annualized.',
  };

  const valueTotal = timeSaved.valueUsd + throughput.valueUsd + stabilityDelta.valueUsd;
  const investmentTotal = aiSpend.valueUsd + training.valueUsd + jCurve.valueUsd;

  // A window with NO shipped output cannot evidence a return, however plausible the
  // assumptions are. Spend is measured; every surviving value term is then pure assumption with
  // nothing in the telemetry anchoring it, so a composite ROI would read as a finding when it is
  // only arithmetic on defaults. Refuse the headline, keep the components and the break-even
  // view (which needs no delivery data) so the spend is still accountable.
  const noShippedOutput = agg.mergedPrs === 0 && agg.deployments === 0;

  // A ratio whose denominator approaches zero produces headline percentages in the thousands
  // from a few dollars of spend. The floor is stated in the model's own units rather than as a
  // magic constant: if a whole year of assistant spend is worth less than one engineer-hour per
  // month, it is not a spending decision a percentage return can describe.
  const annualInvestmentFloor = (a.loadedCostPerYear / HOURS_PER_YEAR) * 12;
  const immaterialSpend = investmentTotal > 0 && investmentTotal < annualInvestmentFloor;

  const computable = investmentTotal > 0 && !noShippedOutput && !immaterialSpend
    && opts.perProjectStaffing === true;
  const roiPct = computable ? round1(((valueTotal - investmentTotal) / investmentTotal) * 100) : null;
  if (investmentTotal <= 0) refusals.push('ROI not computed: total investment is zero.');
  else if (noShippedOutput) {
    refusals.push(
      'ROI not computed: nothing shipped in this window (no merged PRs, no deployments), so no '
      + 'delivery evidence supports a return — only the measured spend and the break-even '
      + 'threshold below are shown.',
    );
  } else if (immaterialSpend) {
    refusals.push(
      'ROI not computed: annualized investment is smaller than one engineer-hour per month, so a '
      + 'percentage return would be division noise rather than a finding.',
    );
  } else if (opts.perProjectStaffing !== true) {
    refusals.push(
      'ROI not computed: this project has no staffing of its own configured (teamSize and loaded '
      + 'cost per year). The value side scales with the team that actually worked here, so '
      + 'borrowing a shared default would claim one team\'s saving once per project. Break-even '
      + 'below needs no such assumption.',
    );
  }
  const paybackMonths = computable && valueTotal > 0 ? round1((investmentTotal / valueTotal) * 12) : null;

  // ---- Break-even (the skeptic-proof lead view: two inputs, no revenue guess) ---------------
  const monthlySpend = (agg.spendUsd / agg.windowDays) * 30.44;
  const hourly = a.loadedCostPerYear / HOURS_PER_YEAR;
  const hoursPerMonth = hourly > 0 ? monthlySpend / hourly : null;
  const pctOfCapacity = hoursPerMonth != null && a.teamSize > 0
    ? round1((hoursPerMonth / (a.teamSize * HOURS_PER_MONTH)) * 100)
    : null;
  const verdict: RoiResult['breakEven']['verdict'] =
    pctOfCapacity == null ? 'unknown' : pctOfCapacity <= RCT_BRACKET.highPct ? 'within-rct-bracket' : 'above-rct-bracket';

  // ---- Unit economics (operational, not ROI) ------------------------------------------------
  const prWeeks = new Map(agg.weeklyMergedPrs.map((w) => [w.weekStart, w.value]));
  const tokensPerMergedPr: WeeklyPoint[] = [];
  for (const w of agg.weeklyTokens) {
    const prs = prWeeks.get(w.weekStart) ?? 0;
    if (prs > 0) tokensPerMergedPr.push({ weekStart: w.weekStart, value: round0(w.value / prs) });
  }
  const unitEconomics: RoiResult['unitEconomics'] = {
    usdPerMergedPr: agg.mergedPrs > 0 ? round2(agg.spendUsd / agg.mergedPrs) : null,
    usdPerDeployment: agg.deployments > 0 ? round2(agg.spendUsd / agg.deployments) : null,
    tokensPerMergedPr,
  };
  if (agg.mergedPrs === 0) notes.push('No merged PRs in window — unit economics unavailable.');

  return {
    window: agg.windowDays,
    annualizationFactor: round2(k),
    value: { timeSaved, throughput, stabilityDelta, totalUsd: round0(valueTotal) },
    investment: { aiSpend, training, jCurve, totalUsd: round0(investmentTotal) },
    roiPct,
    paybackMonths,
    breakEven: {
      hoursPerMonth: hoursPerMonth == null ? null : round1(hoursPerMonth),
      pctOfCapacity,
      verdict,
    },
    unitEconomics,
    uncertainty: {
      bracketLowPct: RCT_BRACKET.lowPct,
      bracketHighPct: RCT_BRACKET.highPct,
      appliedTo: 'netTimeSavedPct',
      note: 'Experimental evidence spans −19% (METR, experienced devs) to +56% (Peng, greenfield task); '
        + 'this model never assumes a multiplier — set netTimeSavedPct from your own evidence.',
    },
    refusals,
    notes,
  };
}

// ---------- reference-class bands + kill-fast + forward estimator ----------

export interface Bands { p25: number; p50: number; p90: number }
export interface ReferenceBands {
  usdPerPr: Bands | null;
  weeklyUsd: Bands | null;
  /** How many weeks of history the bands rest on; <4 → bands are null (refused). */
  weeks: number;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 1) return sorted[0];
  const rank = p * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (rank - lo);
}
const bandsOf = (xs: number[]): Bands | null => {
  if (xs.length < 4) return null;
  const s = [...xs].sort((a, b) => a - b);
  return { p25: round2(percentile(s, 0.25)), p50: round2(percentile(s, 0.5)), p90: round2(percentile(s, 0.9)) };
};

/** P25/P50/P90 of weekly $ and of weekly $/PR from a project's own history (≥4 weeks or refuse). */
export function referenceBands(weeklySpend: readonly WeeklyPoint[], weeklyPrs: readonly WeeklyPoint[]): ReferenceBands {
  const prMap = new Map(weeklyPrs.map((w) => [w.weekStart, w.value]));
  const usdPerPr: number[] = [];
  for (const w of weeklySpend) {
    const prs = prMap.get(w.weekStart) ?? 0;
    if (prs > 0) usdPerPr.push(w.value / prs);
  }
  return {
    usdPerPr: bandsOf(usdPerPr),
    weeklyUsd: bandsOf(weeklySpend.map((w) => w.value)),
    weeks: weeklySpend.length,
  };
}

/**
 * "Review recommended" when spend ran hot while delivery ran cold for 2 CONSECUTIVE weeks.
 * Evaluation is OUT-OF-SAMPLE: each week is compared against bands computed from the weeks
 * BEFORE it (min 4). Including the evaluated week in its own threshold band is self-referential
 * — the most expensive week can never exceed a P90 that contains itself.
 */
export function killFastFlag(
  weeklySpend: readonly WeeklyPoint[],
  weeklyPrs: readonly WeeklyPoint[],
): { flagged: boolean; weeks: string[]; rule: string } {
  const rule = '2 consecutive weeks with spend > P90 and merged PRs < P25 of the PRIOR weeks '
    + '(out-of-sample, min 4 weeks of history) — a signal, not a gate';
  if (weeklySpend.length < 6) return { flagged: false, weeks: [], rule: `${rule}; insufficient history` };
  const prMap = new Map(weeklyPrs.map((w) => [w.weekStart, w.value]));
  const hot: string[] = [];
  let streak: string[] = [];
  for (let i = 4; i < weeklySpend.length; i++) {
    const priorSpend = bandsOf(weeklySpend.slice(0, i).map((w) => w.value));
    const priorPrs = bandsOf(weeklySpend.slice(0, i).map((w) => prMap.get(w.weekStart) ?? 0));
    const w = weeklySpend[i];
    const prs = prMap.get(w.weekStart) ?? 0;
    if (priorSpend && priorPrs && w.value > priorSpend.p90 && prs < priorPrs.p25) {
      streak.push(w.weekStart);
      if (streak.length >= 2) hot.push(...streak.splice(0, streak.length));
    } else {
      streak = [];
    }
  }
  return { flagged: hot.length > 0, weeks: [...new Set(hot)], rule };
}

/** Forward budget + projected break-even for a not-yet-started project, from a reference class. */
export function estimateForward(
  bands: ReferenceBands,
  prsPerMonth: number,
  a: Pick<RoiAssumptions, 'teamSize' | 'loadedCostPerYear'>,
): {
  budgetMonthlyUsd: Bands | null;
  projectedBreakEvenHoursPerMonth: Bands | null;
  pctOfCapacityP50: number | null;
  notes: string[];
} {
  const notes: string[] = [];
  if (!bands.usdPerPr) {
    notes.push(`Reference project has <4 weeks of usable $/PR history (${bands.weeks} weeks) — refusing to fabricate a band.`);
    return { budgetMonthlyUsd: null, projectedBreakEvenHoursPerMonth: null, pctOfCapacityP50: null, notes };
  }
  const budget: Bands = {
    p25: round2(bands.usdPerPr.p25 * prsPerMonth),
    p50: round2(bands.usdPerPr.p50 * prsPerMonth),
    p90: round2(bands.usdPerPr.p90 * prsPerMonth),
  };
  const hourly = a.loadedCostPerYear / HOURS_PER_YEAR;
  const be = (usd: number) => round1(usd / hourly);
  const projected: Bands = { p25: be(budget.p25), p50: be(budget.p50), p90: be(budget.p90) };
  const pct = a.teamSize > 0 ? round1((projected.p50 / (a.teamSize * HOURS_PER_MONTH)) * 100) : null;
  notes.push('Reference-class forecast from the chosen project’s own history — a band, not a promise.');
  return { budgetMonthlyUsd: budget, projectedBreakEvenHoursPerMonth: projected, pctOfCapacityP50: pct, notes };
}
