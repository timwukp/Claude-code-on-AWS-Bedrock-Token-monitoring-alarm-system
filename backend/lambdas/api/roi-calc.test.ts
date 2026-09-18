import {
  ROI_DEFAULTS, RoiAssumptions, RoiWindowAggregates, WeeklyPoint,
  baselineFromHalves, computeRoi, estimateForward, killFastFlag, referenceBands, weeklyFromProjday,
} from './roi-calc';
import { ProjdayItem } from './project-calc';

const wk = (weekStart: string, value: number): WeeklyPoint => ({ weekStart, value });
const agg = (o: Partial<RoiWindowAggregates> = {}): RoiWindowAggregates => ({
  windowDays: 90, spendUsd: 900, tokens: 9_000_000, mergedPrs: 30, deployments: 30,
  cfrPct: 5, mttrHours: 2,
  weeklySpendUsd: [wk('2026-08-03', 70), wk('2026-08-10', 70), wk('2026-08-17', 70), wk('2026-08-24', 70)],
  weeklyTokens: [wk('2026-08-03', 700_000), wk('2026-08-10', 700_000), wk('2026-08-17', 700_000), wk('2026-08-24', 700_000)],
  weeklyMergedPrs: [wk('2026-08-03', 2), wk('2026-08-10', 2), wk('2026-08-17', 2), wk('2026-08-24', 2)],
  ...o,
});
const assume = (o: Partial<RoiAssumptions> = {}): RoiAssumptions => ({
  ...ROI_DEFAULTS, teamSize: 4, loadedCostPerYear: 208_000, // hourly = 100 → easy arithmetic
  ...o, jCurve: { ...ROI_DEFAULTS.jCurve, ...(o.jCurve ?? {}) },
});

/**
 * Every case below except the staffing guard describes a project whose OWN teamSize and loaded
 * cost are configured — that is the only state in which a per-project composite ROI is computed.
 */
const roi = (
  a: RoiWindowAggregates, b: RoiAssumptions,
) => computeRoi(a, b, { perProjectStaffing: true });

describe('computeRoi', () => {
  it('(1) annualizes spend and value terms but NOT training/J-curve', () => {
    const r = roi(agg(), assume({ trainingCostPerUser: 500, jCurve: { include: true, dropPct: 15, months: 3 } }));
    expect(r.annualizationFactor).toBeCloseTo(365 / 90, 2);
    expect(r.investment.aiSpend.valueUsd).toBe(Math.round(900 * (365 / 90))); // 3650
    expect(r.investment.training.valueUsd).toBe(2000); // one-time
    expect(r.investment.jCurve.valueUsd).toBe(Math.round(4 * 208_000 * 0.15 * 0.25)); // 31200, one-time
  });

  it('(2) renders negative ROI honestly (payback null when value ≤ 0)', () => {
    const r = roi(agg(), assume({ netTimeSavedPct: -20 }));
    expect(r.value.timeSaved.valueUsd).toBe(Math.round(4 * 208_000 * -0.2));
    expect(r.roiPct).toBeLessThan(0);
    expect(r.paybackMonths).toBeNull();
  });

  it('(3) stability regression reduces value (signed cost line)', () => {
    const base = { deploymentsPerYear: 120, cfrPct: 5, mttrHours: 2 };
    const good = roi(agg({ cfrPct: 5 }), assume({ baseline: base }));
    const worse = roi(agg({ cfrPct: 10 }), assume({ baseline: base }));
    expect(worse.value.stabilityDelta.valueUsd).toBeLessThan(good.value.stabilityDelta.valueUsd);
    expect(worse.value.stabilityDelta.valueUsd).toBeLessThan(0);
    expect(worse.value.totalUsd).toBeLessThan(good.value.totalUsd);
  });

  it('(4) clamps netTimeSavedPct at the −100 floor with a note', () => {
    const r = roi(agg(), assume({ netTimeSavedPct: -250 }));
    expect(r.value.timeSaved.formulaInputs.netTimeSavedPct).toBe(-100);
    expect(r.notes.join(' ')).toMatch(/floor/);
  });

  it('(5) clamps revenueImpactPerFeature to [0.0001, 0.01]', () => {
    const r = roi(agg(), assume({
      revenueBase: 10_000_000, revenueImpactPerFeature: 0.5,
      baseline: { deploymentsPerYear: 60, cfrPct: 5, mttrHours: 2 },
    }));
    expect(r.value.throughput.formulaInputs.revenueImpactPerFeature).toBe(0.01);
  });

  it('(6) zero-delivery window: unit economics null, throughput refused, break-even still computed', () => {
    const r = roi(agg({ mergedPrs: 0, deployments: 0, cfrPct: null, mttrHours: null, weeklyMergedPrs: [] }), assume());
    expect(r.unitEconomics.usdPerMergedPr).toBeNull();
    expect(r.unitEconomics.usdPerDeployment).toBeNull();
    expect(r.breakEven.hoursPerMonth).not.toBeNull();
  });

  it('(6b) nothing shipped → the ROI headline is refused, not reported from assumptions alone', () => {
    // Regression: with real spend and default assumptions this used to report a confident
    // positive ROI for projects that shipped nothing in the window, because the time-saved term
    // is assumption-only. Components and break-even must survive; the composite must not.
    const r = roi(agg({ mergedPrs: 0, deployments: 0, cfrPct: null, mttrHours: null, weeklyMergedPrs: [] }), assume());
    expect(r.roiPct).toBeNull();
    expect(r.paybackMonths).toBeNull();
    expect(r.refusals.join(' ')).toMatch(/nothing shipped in this window from this project/);
    expect(r.value.timeSaved.valueUsd).toBeGreaterThan(0); // the component is still disclosed
    expect(r.investment.aiSpend.valueUsd).toBeGreaterThan(0);
    expect(r.breakEven.hoursPerMonth).not.toBeNull();
  });

  it('(6c) one deployment is enough to make the composite computable again', () => {
    const r = roi(agg({ mergedPrs: 0, deployments: 1, weeklyMergedPrs: [] }), assume());
    expect(r.roiPct).not.toBeNull();
    expect(r.refusals.join(' ')).not.toMatch(/nothing shipped/);
  });

  it('(6d) without the project’s own staffing the composite is refused, break-even survives', () => {
    // Regression: teamSize/loadedCostPerYear fell back to a shared default, so every project
    // claimed the same team's annual saving and the portfolio total was a multiple of a
    // placeholder. Break-even is a threshold, not a value claim, so it still computes.
    const r = computeRoi(agg(), assume());
    expect(r.roiPct).toBeNull();
    expect(r.paybackMonths).toBeNull();
    expect(r.refusals.join(' ')).toMatch(/no staffing of its own configured/);
    expect(r.breakEven.hoursPerMonth).not.toBeNull();
    expect(computeRoi(agg(), assume(), { perProjectStaffing: true }).roiPct).not.toBeNull();
  });

  it('(6e) immaterial spend is refused instead of producing a four-digit percentage', () => {
    // hourly = 100 → the floor is 12 engineer-hours a year = $1,200 of annualized investment.
    const tiny = roi(agg({ spendUsd: 1, mergedPrs: 1 }), assume());
    expect(tiny.roiPct).toBeNull();
    expect(tiny.refusals.join(' ')).toMatch(/division noise/);
    expect(tiny.investment.aiSpend.valueUsd).toBeGreaterThan(0); // still disclosed
    // Just above the floor it computes again.
    const ok = roi(agg({ spendUsd: 1_000, mergedPrs: 1 }), assume());
    expect(ok.roiPct).not.toBeNull();
  });

  it('(7) zero investment → roiPct null, no division blow-up', () => {
    const r = roi(agg({ spendUsd: 0 }), assume({ trainingCostPerUser: 0 }));
    expect(r.roiPct).toBeNull();
    expect(r.refusals.join(' ')).toMatch(/investment is zero/);
  });

  it('(8) missing baseline → stability AND throughput refused with explicit notes', () => {
    const r = roi(agg(), assume({ revenueBase: 1_000_000 }));
    expect(r.value.stabilityDelta.valueUsd).toBe(0);
    expect(r.refusals.some((x) => x.includes('Stability delta'))).toBe(true);
    expect(r.refusals.some((x) => x.includes('baseline'))).toBe(true);
  });

  it('(9) jCurve.include=false excludes it from investment', () => {
    const r = roi(agg(), assume());
    expect(r.investment.jCurve.valueUsd).toBe(0);
  });

  it('(10) break-even arithmetic matches a hand fixture', () => {
    // 900 over 90d → monthly 900/90×30.44 = 304.4; hourly 208000/2080 = 100 → 3.044 h/mo
    const r = roi(agg(), assume());
    expect(r.breakEven.hoursPerMonth).toBeCloseTo(3.0, 1);
    // capacity: 4 × 173.33 = 693.3 h/mo → 3.044/693.3 ≈ 0.4%
    expect(r.breakEven.pctOfCapacity).toBeCloseTo(0.4, 1);
    expect(r.breakEven.verdict).toBe('within-rct-bracket');
  });

  it('(11) revenueBase=0 → throughput 0 with a refusal string', () => {
    const r = roi(agg(), assume({ baseline: { deploymentsPerYear: 60, cfrPct: 5, mttrHours: 2 } }));
    expect(r.value.throughput.valueUsd).toBe(0);
    expect(r.refusals.some((x) => x.includes('revenue base'))).toBe(true);
  });
});

describe('referenceBands / killFastFlag / estimateForward', () => {
  const spend8 = ['08-03', '08-10', '08-17', '08-24', '08-31', '09-07', '09-14', '09-21']
    .map((d, i) => wk(`2026-${d}`, [50, 60, 70, 80, 90, 100, 110, 400][i]));
  const prs8 = spend8.map((w, i) => wk(w.weekStart, [5, 5, 5, 5, 5, 5, 5, 0][i]));

  it('(12) percentile bands on 8 weeks; <4 weeks → null', () => {
    const b = referenceBands(spend8, prs8);
    expect(b.weeklyUsd).not.toBeNull();
    expect(b.weeklyUsd!.p50).toBeCloseTo(85, 0);
    expect(b.weeklyUsd!.p90).toBeGreaterThan(b.weeklyUsd!.p50);
    expect(referenceBands(spend8.slice(0, 3), prs8.slice(0, 3)).weeklyUsd).toBeNull();
  });

  it('(13) kill-fast fires only on 2 CONSECUTIVE out-of-sample hot-cold weeks', () => {
    // one hot week only → no flag
    expect(killFastFlag(spend8, prs8).flagged).toBe(false);
    const spendHot = [...spend8.slice(0, 6), wk('2026-09-14', 500), wk('2026-09-21', 500)];
    const prsCold = [...prs8.slice(0, 6), wk('2026-09-14', 0), wk('2026-09-21', 0)];
    const hot = killFastFlag(spendHot, prsCold);
    expect(hot.flagged).toBe(true); // evaluated against PRIOR weeks' bands — no self-reference
    expect(hot.weeks).toEqual(['2026-09-14', '2026-09-21']);
    // non-consecutive hot weeks → false
    const gap = [...spend8.slice(0, 5), wk('2026-09-07', 500), wk('2026-09-14', 60), wk('2026-09-21', 500)];
    const gapPrs = [...prs8.slice(0, 5), wk('2026-09-07', 0), wk('2026-09-14', 5), wk('2026-09-21', 0)];
    expect(killFastFlag(gap, gapPrs).flagged).toBe(false);
    // insufficient history → refused, disclosed in the rule string
    expect(killFastFlag(spend8.slice(0, 5), prs8.slice(0, 5)).rule).toMatch(/insufficient history/);
  });

  it('(14) weeklyFromProjday groups by ISO week across a month boundary with per-model pricing', () => {
    const items: ProjdayItem[] = [
      // 2026-08-31 (Mon) and 2026-09-01 (Tue) share the ISO week starting 2026-08-31
      { day: '2026-08-31', projectId: 'p', modelId: 'us.anthropic.claude-sonnet-4-6', inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, invocations: 1 },
      { day: '2026-09-01', projectId: 'p', modelId: 'us.anthropic.claude-haiku-4-5-20251001-v1:0', inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, invocations: 1 },
      { day: '2026-09-07', projectId: 'p', modelId: 'us.anthropic.claude-sonnet-4-6', inputTokens: 2_000_000, outputTokens: 0, cacheReadTokens: 0, invocations: 1 },
    ];
    const { spend, tokens } = weeklyFromProjday(items);
    expect(spend.map((w) => w.weekStart)).toEqual(['2026-08-31', '2026-09-07']);
    expect(spend[0].value).toBeCloseTo(3 + 1, 6);   // sonnet 1M×3e-6 + haiku 1M×1e-6
    expect(spend[1].value).toBeCloseTo(6, 6);
    expect(tokens[0].value).toBe(2_000_000);
  });

  it('estimateForward: band arithmetic + refusal below 4 weeks', () => {
    const bands = referenceBands(spend8, prs8);
    const est = estimateForward(bands, 10, { teamSize: 4, loadedCostPerYear: 208_000 });
    expect(est.budgetMonthlyUsd!.p50).toBeCloseTo(bands.usdPerPr!.p50 * 10, 2);
    expect(est.projectedBreakEvenHoursPerMonth!.p50).toBeCloseTo((bands.usdPerPr!.p50 * 10) / 100, 1);
    const refused = estimateForward(referenceBands(spend8.slice(0, 2), prs8.slice(0, 2)), 10, { teamSize: 4, loadedCostPerYear: 208_000 });
    expect(refused.budgetMonthlyUsd).toBeNull();
    expect(refused.notes.join(' ')).toMatch(/refusing to fabricate/);
  });
});

describe('baselineFromHalves', () => {
  const weeks = ['08-03', '08-10', '08-17', '08-24'].map((d) => wk(`2026-${d}`, 5));
  it('produces an annualized baseline when both halves have ≥3 deployments', () => {
    const b = baselineFromHalves(weeks, 5, 2, 28);
    expect(b).not.toBeNull();
    expect(b!.deploymentsPerYear).toBeCloseTo((10 / 14) * 365, 0);
  });
  it('refuses on thin halves or missing quality metrics', () => {
    expect(baselineFromHalves([wk('2026-08-03', 1), wk('2026-08-10', 1), wk('2026-08-17', 5), wk('2026-08-24', 5)], 5, 2, 28)).toBeNull();
    expect(baselineFromHalves(weeks, null, 2, 28)).toBeNull();
  });
});
