import {
  BANDS_2024_REFERENCE, CFR_BANDS_2024, computeDora, deployFrequencyBand, hoursBetween, isoWeek, median, percentile, tierFor,
} from './dora-calc';
import { IssueForMetrics, PrForMetrics } from './types';

const NOW = new Date('2026-09-16T12:00:00.000Z');
const H = 3_600_000;
const iso = (hoursAgo: number) => new Date(NOW.getTime() - hoursAgo * H).toISOString();

let seq = 0;
/** Fixture builder: `mergedHoursAgo` places the merge; lead/review durations are relative to it. */
function pr(o: {
  mergedHoursAgo: number;
  leadHours?: number; // firstCommit → merge
  reviewHours?: number; // created → merge
  assistedBy?: PrForMetrics['assistedBy'];
  isRevert?: boolean;
  isHotfix?: boolean;
}): PrForMetrics {
  const lead = o.leadHours ?? 10;
  const review = Math.min(o.reviewHours ?? 4, lead);
  return {
    number: ++seq,
    mergedAt: iso(o.mergedHoursAgo),
    firstCommitAt: iso(o.mergedHoursAgo + lead),
    createdAt: iso(o.mergedHoursAgo + review),
    assistedBy: o.assistedBy ?? null,
    isRevert: o.isRevert ?? false,
    isHotfix: o.isHotfix ?? false,
  };
}
const issue = (createdHoursAgo: number, resolveHours: number | null): IssueForMetrics => ({
  number: ++seq,
  createdAt: iso(createdHoursAgo),
  closedAt: resolveHours == null ? null : iso(createdHoursAgo - resolveHours),
});

describe('stats helpers', () => {
  it('median handles empty, odd and even samples', () => {
    expect(median([])).toBeNull();
    expect(median([5])).toBe(5);
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });
  it('percentile interpolates linearly', () => {
    expect(percentile([], 0.95)).toBeNull();
    expect(percentile([7], 0.95)).toBe(7);
    expect(percentile([1, 2, 3, 4, 5], 0.5)).toBe(3);
    expect(percentile([1, 2, 3, 4, 5], 0.95)).toBeCloseTo(4.8);
  });
  it('hoursBetween clamps negatives (rebased commits dated after merge)', () => {
    expect(hoursBetween(iso(1), iso(0))).toBe(1);
    expect(hoursBetween(iso(0), iso(1))).toBe(0);
  });
});

describe('tierFor', () => {
  it('deployment frequency boundaries (per day)', () => {
    expect(tierFor('df', 1)).toBe('Elite');
    expect(tierFor('df', 0.99)).toBe('High');
    expect(tierFor('df', 1 / 7)).toBe('High');
    expect(tierFor('df', 0.1)).toBe('Medium');
    expect(tierFor('df', 1 / 30)).toBe('Medium');
    expect(tierFor('df', 0.01)).toBe('Low');
    expect(tierFor('df', null)).toBe('Unknown');
  });
  it('lead time / recovery-time boundaries (lower is better)', () => {
    expect(tierFor('lt', 24)).toBe('Elite');
    expect(tierFor('lt', 24.1)).toBe('High');
    expect(tierFor('lt', 168)).toBe('High');
    expect(tierFor('lt', 720)).toBe('Medium');
    expect(tierFor('lt', 721)).toBe('Low');
    expect(tierFor('mttr', 1)).toBe('Elite');
    expect(tierFor('mttr', 24)).toBe('High');
    expect(tierFor('mttr', 168)).toBe('Medium');
    expect(tierFor('mttr', 169)).toBe('Low');
  });
  // The 2024 CFR values are non-monotonic (Elite 5, High 20, Medium 10, Low 40), so no threshold
  // ordering can reproduce the tiers. Refusing beats inventing an ordering DORA does not publish.
  it('refuses a tier for change failure rate at every value', () => {
    for (const v of [0, 5, 10, 15, 20, 40, 100, null]) expect(tierFor('cfr', v)).toBe('Unknown');
  });
  it('publishes the four 2024 CFR reference values in report order, non-monotonic as printed', () => {
    expect(CFR_BANDS_2024.map((b) => b.tier)).toEqual(['Elite', 'High', 'Medium', 'Low']);
    expect(CFR_BANDS_2024.map((b) => b.pct)).toEqual([5, 20, 10, 40]);
  });
});

describe('BANDS_2024_REFERENCE', () => {
  it('covers every metric that has a tier, and never change fail rate', () => {
    expect(BANDS_2024_REFERENCE.map((r) => r.metric).sort()).toEqual(['df', 'lt', 'mttr']);
    // A cfr row here would re-assert the tier this codebase deliberately refuses: the published
    // 2024 values are non-monotonic, so no boundary ordering reproduces them.
    expect(BANDS_2024_REFERENCE.some((r) => (r.metric as string) === 'cfr')).toBe(false);
  });

  it('states four levels per metric, best first, in words rather than raw boundaries', () => {
    for (const row of BANDS_2024_REFERENCE) {
      expect(row.bands.map((b) => b.tier)).toEqual(['Elite', 'High', 'Medium', 'Low']);
      // The fallback renderings ("0.14 per day", "24 hours") mean a threshold moved without its
      // wording being updated; the table would then read like arithmetic, not like a benchmark.
      for (const b of row.bands) expect(b.text).not.toMatch(/\d/);
    }
  });

  it('re-expresses the thresholds in the units the tiers are computed from', () => {
    const df = BANDS_2024_REFERENCE.find((r) => r.metric === 'df')!;
    expect(df.label).toBe('Deployment frequency');
    expect(df.bands.map((b) => b.text)).toEqual([
      'at least once per day', 'at least once per week', 'at least once per month', 'less than once per month',
    ]);
    const lt = BANDS_2024_REFERENCE.find((r) => r.metric === 'lt')!;
    expect(lt.label).toBe('Change lead time');
    expect(lt.bands.map((b) => b.text)).toEqual([
      'within one day', 'within one week', 'within one month', 'more than one month',
    ]);
    // DORA's own name for the metric these bands were published against - which is NOT what our
    // `mttr` field computes. The page has to keep saying so; the data must not quietly imply it.
    const mttr = BANDS_2024_REFERENCE.find((r) => r.metric === 'mttr')!;
    expect(mttr.label).toBe('Failed deployment recovery time');
    expect(mttr.bands.map((b) => b.text)).toEqual([
      'within one hour', 'within one day', 'within one week', 'more than one week',
    ]);
  });

  it('agrees with tierFor at every published boundary', () => {
    expect(tierFor('df', 1)).toBe('Elite');
    expect(tierFor('df', 1 / 7)).toBe('High');
    expect(tierFor('df', 1 / 30)).toBe('Medium');
    expect(tierFor('lt', 24)).toBe('Elite');
    expect(tierFor('mttr', 1)).toBe('Elite');
  });
});

describe('deployFrequencyBand', () => {
  it('maps a rate onto DORA\'s six ordinal buckets', () => {
    expect(deployFrequencyBand(3)).toBe('On demand (multiple deploys per day)');
    expect(deployFrequencyBand(2)).toBe('On demand (multiple deploys per day)');
    expect(deployFrequencyBand(1.5)).toBe('Between once per hour and once per day');
    expect(deployFrequencyBand(0.5)).toBe('Between once per day and once per week');
    expect(deployFrequencyBand(1 / 7)).toBe('Between once per day and once per week');
    expect(deployFrequencyBand(0.1)).toBe('Between once per week and once per month');
    expect(deployFrequencyBand(1 / 30)).toBe('Between once per week and once per month');
    expect(deployFrequencyBand(0.02)).toBe('Between once per month and once every six months');
    expect(deployFrequencyBand(0.001)).toBe('Less than once per six months');
  });
  // The source leaves 1.0/day on a seam; we assign it upward and say so, rather than letting the
  // choice sit implicit in a comparison operator.
  it('assigns exactly one per day to the hour-to-day bucket, and reserves the top for 2+/day', () => {
    expect(deployFrequencyBand(1)).toBe('Between once per hour and once per day');
    expect(deployFrequencyBand(0.999)).toBe('Between once per day and once per week');
    expect(deployFrequencyBand(1.999)).toBe('Between once per hour and once per day');
  });
  it('has no band without a sample', () => {
    expect(deployFrequencyBand(null)).toBeNull();
    expect(deployFrequencyBand(0)).toBeNull();
    expect(deployFrequencyBand(Number.NaN)).toBeNull();
  });
});

describe('isoWeek', () => {
  it('assigns Monday..Sunday to the same week and returns the Monday', () => {
    expect(isoWeek(new Date('2026-09-14T00:00:00Z'))).toEqual({ key: '2026-W38', weekStart: '2026-09-14' });
    expect(isoWeek(new Date('2026-09-20T23:59:59Z'))).toEqual({ key: '2026-W38', weekStart: '2026-09-14' });
    expect(isoWeek(new Date('2026-09-21T00:00:00Z')).key).toBe('2026-W39');
  });
  it('handles the year rollover per ISO 8601', () => {
    // 2025-12-29 is a Monday belonging to ISO week 1 of 2026.
    expect(isoWeek(new Date('2025-12-29T10:00:00Z'))).toEqual({ key: '2026-W01', weekStart: '2025-12-29' });
    expect(isoWeek(new Date('2026-01-04T10:00:00Z')).key).toBe('2026-W01');
    // 2027-01-01 is a Friday → still ISO week 53 of 2026.
    expect(isoWeek(new Date('2027-01-01T00:00:00Z')).key).toBe('2026-W53');
  });
});

describe('computeDora', () => {
  it('returns Unknown tiers and null values for an empty sample', () => {
    const m = computeDora([], [], { windowDays: 30, now: NOW });
    expect(m.deploymentFrequency.all).toMatchObject({ value: null, tier: 'Unknown', n: 0, deployments: 0 });
    expect(m.leadTime.all).toMatchObject({ value: null, tier: 'Unknown', p95: null, mean: null });
    expect(m.changeFailRate.all).toMatchObject({ value: null, tier: 'Unknown', failures: 0 });
    expect(m.mttr.all).toMatchObject({ value: null, tier: 'Unknown', n: 0 });
    expect(m.aiParticipationPct).toBeNull();
    expect(m.sample).toMatchObject({ mergedPrs: 0, incidents: 0, windowDays: 30 });
    // Continuous weekly axis even with no data.
    expect(m.timeline.length).toBeGreaterThanOrEqual(5);
    expect(m.timeline.every((b) => b.deploysAi === 0 && b.deploysHuman === 0)).toBe(true);
  });

  it('excludes PRs merged outside the window and incidents created outside it', () => {
    const m = computeDora(
      [pr({ mergedHoursAgo: 1 }), pr({ mergedHoursAgo: 24 * 8 })],
      [issue(24 * 2, 1), issue(24 * 40, 1)],
      { windowDays: 7, now: NOW },
    );
    expect(m.sample.mergedPrs).toBe(1);
    expect(m.sample.incidents).toBe(1);
  });

  it('computes deployment frequency per day with tiers', () => {
    const prs = Array.from({ length: 30 }, (_, i) => pr({ mergedHoursAgo: i * 20 + 1 }));
    const m = computeDora(prs, [], { windowDays: 30, now: NOW });
    expect(m.deploymentFrequency.all).toMatchObject({
      deployments: 30, perDay: 1, tier: 'Elite', band: 'Between once per hour and once per day',
    });
    const weekly = computeDora([pr({ mergedHoursAgo: 5 })], [], { windowDays: 7, now: NOW });
    expect(weekly.deploymentFrequency.all).toMatchObject({
      perDay: 0.14, tier: 'High', band: 'Between once per day and once per week',
    });
  });

  it('computes lead time median / p95 / mean and the coding vs review breakdown', () => {
    const m = computeDora(
      [
        pr({ mergedHoursAgo: 1, leadHours: 10, reviewHours: 4 }),
        pr({ mergedHoursAgo: 2, leadHours: 30, reviewHours: 10 }),
        pr({ mergedHoursAgo: 3, leadHours: 50, reviewHours: 20 }),
      ],
      [],
      { windowDays: 30, now: NOW },
    );
    expect(m.leadTime.all).toMatchObject({ value: 30, mean: 30, n: 3, tier: 'High' });
    expect(m.leadTime.all.p95).toBeCloseTo(48, 0);
    expect(m.leadTime.all.reviewHours).toBe(10);
    expect(m.leadTime.all.codingHours).toBe(20); // (10−4, 30−10, 50−20) → median 20
  });

  it('computes CFR from reverts + hotfixes + incidents, capped at 100', () => {
    const m = computeDora(
      [
        pr({ mergedHoursAgo: 1, isRevert: true }),
        pr({ mergedHoursAgo: 2, isHotfix: true }),
        pr({ mergedHoursAgo: 3 }),
        pr({ mergedHoursAgo: 4 }),
      ],
      [issue(10, 2)],
      { windowDays: 30, now: NOW },
    );
    expect(m.changeFailRate.all).toMatchObject({ reverts: 1, hotfixes: 1, incidents: 1, failures: 3, value: 75, tier: 'Unknown' });
    const capped = computeDora([pr({ mergedHoursAgo: 1, isRevert: true })], [issue(5, 1), issue(6, 1)], { windowDays: 30, now: NOW });
    expect(capped.changeFailRate.all.value).toBe(100);
    const clean = computeDora([pr({ mergedHoursAgo: 1 }), pr({ mergedHoursAgo: 2 })], [], { windowDays: 30, now: NOW });
    // 0% is the best possible rate and still gets no tier: the tier is a cluster over all five
    // metrics, not a threshold on this one. The value is what the page shows.
    expect(clean.changeFailRate.all).toMatchObject({ value: 0, tier: 'Unknown' });
  });

  it('computes MTTR from hotfix PR durations and closed incident issues only', () => {
    const m = computeDora(
      [pr({ mergedHoursAgo: 1, isHotfix: true, reviewHours: 2, leadHours: 2 })],
      [issue(20, 6), issue(30, null)],
      { windowDays: 30, now: NOW },
    );
    expect(m.mttr.all).toMatchObject({ value: 4, n: 2, tier: 'High' }); // median(2h, 6h); open issue ignored
  });

  it('splits every metric into AI-assisted vs human-only cohorts', () => {
    const m = computeDora(
      [
        pr({ mergedHoursAgo: 1, leadHours: 5, assistedBy: 'claude-code' }),
        pr({ mergedHoursAgo: 2, leadHours: 7, assistedBy: 'kiro' }),
        pr({ mergedHoursAgo: 3, leadHours: 100 }),
        pr({ mergedHoursAgo: 4, leadHours: 200, isRevert: true }),
      ],
      [issue(10, 1)],
      { windowDays: 30, now: NOW },
    );
    expect(m.aiParticipationPct).toBe(50);
    expect(m.byAssistant).toEqual({ 'claude-code': 1, kiro: 1, 'amazon-q': 0, copilot: 0 });
    expect(m.deploymentFrequency.ai.deployments).toBe(2);
    expect(m.deploymentFrequency.human.deployments).toBe(2);
    expect(m.leadTime.ai.value).toBe(6);
    expect(m.leadTime.human.value).toBe(150);
    // Incidents count only in `all`; cohorts use their own denominators.
    expect(m.changeFailRate.all).toMatchObject({ failures: 2, value: 50 });
    expect(m.changeFailRate.ai).toMatchObject({ failures: 0, incidents: 0, value: 0 });
    expect(m.changeFailRate.human).toMatchObject({ failures: 1, incidents: 0, value: 50 });
    expect(m.mttr.human.n).toBe(0);
  });

  it('buckets the weekly timeline by ISO week with a continuous axis', () => {
    const m = computeDora(
      [pr({ mergedHoursAgo: 1, assistedBy: 'claude-code' }), pr({ mergedHoursAgo: 2 }), pr({ mergedHoursAgo: 24 * 8, isHotfix: true })],
      [issue(24 * 9, 1)],
      { windowDays: 30, now: NOW },
    );
    const keys = m.timeline.map((b) => b.week);
    expect(keys).toEqual([...keys].sort());
    expect(keys.at(-1)).toBe('2026-W38');
    const thisWeek = m.timeline.find((b) => b.week === '2026-W38')!;
    expect(thisWeek).toMatchObject({ deploysAi: 1, deploysHuman: 1, failures: 0 });
    const lastWeek = m.timeline.find((b) => b.week === '2026-W37')!;
    expect(lastWeek).toMatchObject({ deploysHuman: 1, failures: 2 });
    // Weeks with no merges keep a null median rather than 0.
    expect(m.timeline.find((b) => b.week === '2026-W36')!.medianLeadHours).toBeNull();
  });
});
