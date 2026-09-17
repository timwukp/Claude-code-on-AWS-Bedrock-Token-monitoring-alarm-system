/**
 * Pure DORA metric math (no I/O) so it is unit-testable offline. Definitions and tier
 * thresholds are ported from the reference implementation (`dora_calculator.py`):
 *
 *  - Deployment Frequency  = merged PRs in window / days             (deploy := merge to default)
 *  - Lead Time for Changes = median(mergedAt − firstCommitAt) hours   (+ p95, mean, coding/review)
 *  - Change Failure Rate   = (reverts + hotfixes + incidents) / merged PRs × 100, capped at 100
 *  - Time to Restore       = median(hotfix mergedAt − createdAt ∪ incident closedAt − createdAt)
 *
 * How these relate to DORA's canonical definitions, so nothing here overclaims
 * (`docs/research-dora-presentation.md` has the citations):
 *
 *  - DORA anchors all of its metrics on **production deployment**. Merge-to-default is a PROXY;
 *    DORA's own reference implementation says a merge push event "is not its own distinct change"
 *    and that deriving deployment metrics from it "artificially skews the metrics". Every surface
 *    that shows deployment frequency must therefore label it as a proxy at the number itself.
 *  - Lead time's START point matches DORA exactly (commit to version control). Only the END point
 *    is a proxy: DORA stops at production, we stop at merge. So this is the first part of DORA's
 *    window, not a different measure of the whole thing.
 *  - `mttr` is **not** DORA's "failed deployment recovery time". That metric was renamed AND
 *    redefined in 2023, narrowing scope to impairments caused by a change reaching production;
 *    ours also counts bug/incident issues with no deployment linkage. Relabelling it without
 *    narrowing the computation would be worse than the old name, so the field keeps its name and
 *    the UI says what it actually measures.
 *  - DORA has had FIVE metrics since 2024. Deployment rework rate (deployments that were unplanned
 *    fixes) needs a signal we do not collect, so it is reported as a gap rather than omitted
 *    silently.
 *
 * Every metric is reported for three cohorts — all PRs, AI-assisted PRs, human-only PRs — so the
 * dashboard can answer "does AI participation change our delivery performance?". Incidents are
 * not attributable to a cohort, so they count only in `all`.
 */
import { AssistedBy, IssueForMetrics, PrForMetrics } from './types';

export type Tier = 'Elite' | 'High' | 'Medium' | 'Low' | 'Unknown';
export type Cohort = 'all' | 'ai' | 'human';
export type MetricKey = 'df' | 'lt' | 'cfr' | 'mttr';

export interface MetricValue {
  /** Headline value (null when the sample is empty). */
  value: number | null;
  tier: Tier;
  /** Sample size the value was computed from. */
  n: number;
}
export interface Split<T> { all: T; ai: T; human: T }

export interface DeploymentFrequency extends MetricValue {
  /** Same as value — merged PRs per day. */
  perDay: number | null;
  deployments: number;
  /**
   * The rate re-expressed as DORA's own ordinal band, verbatim from the Quick Check's
   * `deployfreq` responses. DORA never states this metric as a rate — every one of its
   * instruments uses these phrases — and "about once a week" is the form a non-expert reads
   * correctly on the first pass. `null` when there is no sample.
   * See `docs/research-dora-presentation.md` §1.3.
   */
  band: string | null;
}
export interface LeadTime extends MetricValue {
  p95: number | null;
  mean: number | null;
  /** Median hours from first commit to PR open. */
  codingHours: number | null;
  /** Median hours from PR open to merge. */
  reviewHours: number | null;
}
export interface ChangeFailureRate extends MetricValue {
  reverts: number;
  hotfixes: number;
  incidents: number;
  failures: number;
}
export type Mttr = MetricValue;

export interface WeekBucket {
  /** ISO week key, e.g. "2026-W37". */
  week: string;
  /** Monday 00:00 UTC of that week (ISO date). */
  weekStart: string;
  deploysAi: number;
  deploysHuman: number;
  medianLeadHours: number | null;
  failures: number;
}

export interface DoraMetrics {
  deploymentFrequency: Split<DeploymentFrequency>;
  leadTime: Split<LeadTime>;
  changeFailureRate: Split<ChangeFailureRate>;
  mttr: Split<Mttr>;
  /** % of merged PRs in window with an AI assistant attributed (null if no PRs). */
  aiParticipationPct: number | null;
  byAssistant: Record<Exclude<AssistedBy, null>, number>;
  timeline: WeekBucket[];
  sample: { mergedPrs: number; incidents: number; windowDays: number; from: string; to: string };
}

// ---------- tiers ----------

type Threshold = readonly [number, Tier];
/**
 * [boundary, tier] in order; first match wins. Boundaries are the 2024 report's bands (p. 13)
 * converted to our units — deployment frequency from "on demand / per day / per week / per month"
 * and the two duration metrics from hours.
 *
 * `cfr` is deliberately absent. The 2024 change-fail-rate values are NON-monotonic across the
 * tiers — Elite 5%, **High 20%, Medium 10%**, Low 40% — because the clusters are discovered over
 * the whole metric vector, not thresholded per metric. DORA discusses this itself as "one of the
 * potential pitfalls of using these performance levels". A tier therefore cannot be derived from
 * a change failure rate alone, so we do not invent one: `tierFor('cfr', …)` returns `Unknown` and
 * the UI shows the measured percentage against `CFR_BANDS_2024` as reference values instead.
 * See `docs/research-dora-presentation.md` §1.4.
 */
const TIERS: Record<Exclude<MetricKey, 'cfr'>, { higherIsBetter: boolean; thresholds: readonly Threshold[] }> = {
  df: { higherIsBetter: true, thresholds: [[1, 'Elite'], [1 / 7, 'High'], [1 / 30, 'Medium']] },
  lt: { higherIsBetter: false, thresholds: [[24, 'Elite'], [168, 'High'], [720, 'Medium']] },
  mttr: { higherIsBetter: false, thresholds: [[1, 'Elite'], [24, 'High'], [168, 'Medium']] },
};

/** The four published 2024 change-fail-rate values, in report order. Reference marks, not bands. */
export const CFR_BANDS_2024: readonly { readonly tier: Exclude<Tier, 'Unknown'>; readonly pct: number }[] = [
  { tier: 'Elite', pct: 5 },
  { tier: 'High', pct: 20 },
  { tier: 'Medium', pct: 10 },
  { tier: 'Low', pct: 40 },
];

export function tierFor(metric: MetricKey, value: number | null): Tier {
  if (metric === 'cfr') return 'Unknown';
  if (value == null || !Number.isFinite(value)) return 'Unknown';
  const { higherIsBetter, thresholds } = TIERS[metric];
  for (const [boundary, tier] of thresholds) {
    if (higherIsBetter ? value >= boundary : value <= boundary) return tier;
  }
  return 'Low';
}

/**
 * DORA's six ordinal deployment-frequency buckets, verbatim from the Quick Check's
 * `metrics_question_responses.json`, highest first.
 */
const DEPLOY_FREQ_BANDS: readonly { readonly minPerDay: number; readonly label: string }[] = [
  { minPerDay: 2, label: 'On demand (multiple deploys per day)' },
  { minPerDay: 1, label: 'Between once per hour and once per day' },
  { minPerDay: 1 / 7, label: 'Between once per day and once per week' },
  { minPerDay: 1 / 30, label: 'Between once per week and once per month' },
  { minPerDay: 1 / 182, label: 'Between once per month and once every six months' },
];

/**
 * Map a measured per-day rate onto DORA's ordinal band.
 *
 * Boundary rule, stated because the source leaves it open: a rate of exactly 1.0/day sits on the
 * seam between "between once per day and once per week" and "between once per hour and once per
 * day". We assign it upward, so >=1/day is at least the hour-to-day band, and reserve the top
 * band for >=2/day, which is what "multiple deploys per day" literally says.
 */
export function deployFrequencyBand(perDay: number | null): string | null {
  if (perDay == null || !Number.isFinite(perDay) || perDay <= 0) return null;
  for (const { minPerDay, label } of DEPLOY_FREQ_BANDS) if (perDay >= minPerDay) return label;
  return 'Less than once per six months';
}

// ---------- stats ----------

export function median(xs: readonly number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export function mean(xs: readonly number[]): number | null {
  if (xs.length === 0) return null;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

/** Linear-interpolation percentile (p in 0..1), matching numpy's default. */
export function percentile(xs: readonly number[], p: number): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  if (s.length === 1) return s[0];
  const rank = Math.min(Math.max(p, 0), 1) * (s.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  return lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (rank - lo);
}

const round1 = (n: number | null) => (n == null ? null : Math.round(n * 10) / 10);
const round2 = (n: number | null) => (n == null ? null : Math.round(n * 100) / 100);

// ---------- time helpers ----------

const HOUR = 3_600_000;
const DAY = 86_400_000;
const ms = (iso: string) => new Date(iso).getTime();
/** Hours between two ISO timestamps, clamped at 0 (rebases can put commit dates after merge). */
export const hoursBetween = (fromIso: string, toIso: string) => Math.max(0, (ms(toIso) - ms(fromIso)) / HOUR);

/** ISO-8601 week key + Monday (UTC) for a date. */
export function isoWeek(d: Date): { key: string; weekStart: string } {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = t.getUTCDay() || 7; // Mon=1..Sun=7
  const monday = new Date(t.getTime() - (dayNum - 1) * DAY);
  // ISO week-numbering year is the year of the Thursday in this week.
  const thursday = new Date(monday.getTime() + 3 * DAY);
  const isoYear = thursday.getUTCFullYear();
  const jan4 = new Date(Date.UTC(isoYear, 0, 4));
  const jan4Day = jan4.getUTCDay() || 7;
  const week1Monday = new Date(jan4.getTime() - (jan4Day - 1) * DAY);
  const weekNo = Math.round((monday.getTime() - week1Monday.getTime()) / (7 * DAY)) + 1;
  return { key: `${isoYear}-W${String(weekNo).padStart(2, '0')}`, weekStart: monday.toISOString().slice(0, 10) };
}

// ---------- core ----------

const inCohort = (pr: PrForMetrics, cohort: Cohort) =>
  cohort === 'all' ? true : cohort === 'ai' ? pr.assistedBy != null : pr.assistedBy == null;

function deploymentFrequency(prs: PrForMetrics[], days: number): DeploymentFrequency {
  const n = prs.length;
  const perDay = n === 0 ? null : n / Math.max(days, 1);
  return {
    value: round2(perDay), perDay: round2(perDay), deployments: n, n,
    tier: tierFor('df', perDay), band: deployFrequencyBand(perDay),
  };
}

function leadTime(prs: PrForMetrics[]): LeadTime {
  const lead = prs.map((p) => hoursBetween(p.firstCommitAt, p.mergedAt));
  const coding = prs.map((p) => hoursBetween(p.firstCommitAt, p.createdAt));
  const review = prs.map((p) => hoursBetween(p.createdAt, p.mergedAt));
  const med = median(lead);
  return {
    value: round1(med),
    tier: tierFor('lt', med),
    n: prs.length,
    p95: round1(percentile(lead, 0.95)),
    mean: round1(mean(lead)),
    codingHours: round1(median(coding)),
    reviewHours: round1(median(review)),
  };
}

function changeFailureRate(prs: PrForMetrics[], incidents: number): ChangeFailureRate {
  const reverts = prs.filter((p) => p.isRevert).length;
  const hotfixes = prs.filter((p) => p.isHotfix && !p.isRevert).length;
  const failures = reverts + hotfixes + incidents;
  const n = prs.length;
  const pct = n === 0 ? null : Math.min(100, (failures / n) * 100);
  return { value: round1(pct), tier: tierFor('cfr', pct), n, reverts, hotfixes, incidents, failures };
}

function mttr(prs: PrForMetrics[], issues: IssueForMetrics[]): Mttr {
  const fromHotfix = prs.filter((p) => p.isHotfix).map((p) => hoursBetween(p.createdAt, p.mergedAt));
  const fromIncidents = issues
    .filter((i): i is IssueForMetrics & { closedAt: string } => !!i.closedAt)
    .map((i) => hoursBetween(i.createdAt, i.closedAt));
  const xs = [...fromHotfix, ...fromIncidents];
  const med = median(xs);
  return { value: round1(med), tier: tierFor('mttr', med), n: xs.length };
}

function timeline(prs: PrForMetrics[], issues: IssueForMetrics[], from: Date, to: Date): WeekBucket[] {
  const buckets = new Map<string, WeekBucket & { lead: number[] }>();
  // Pre-create every week in the window so charts have a continuous axis.
  for (let t = isoWeek(from).weekStart; ms(t) <= to.getTime(); t = new Date(ms(t) + 7 * DAY).toISOString().slice(0, 10)) {
    const w = isoWeek(new Date(t));
    buckets.set(w.key, { week: w.key, weekStart: w.weekStart, deploysAi: 0, deploysHuman: 0, medianLeadHours: null, failures: 0, lead: [] });
  }
  const get = (iso: string) => {
    const w = isoWeek(new Date(iso));
    let b = buckets.get(w.key);
    if (!b) {
      b = { week: w.key, weekStart: w.weekStart, deploysAi: 0, deploysHuman: 0, medianLeadHours: null, failures: 0, lead: [] };
      buckets.set(w.key, b);
    }
    return b;
  };
  for (const p of prs) {
    const b = get(p.mergedAt);
    if (p.assistedBy) b.deploysAi += 1; else b.deploysHuman += 1;
    b.lead.push(hoursBetween(p.firstCommitAt, p.mergedAt));
    if (p.isRevert || p.isHotfix) b.failures += 1;
  }
  for (const i of issues) get(i.createdAt).failures += 1;
  return [...buckets.values()]
    .sort((a, b) => a.weekStart.localeCompare(b.weekStart))
    .map(({ lead, ...b }) => ({ ...b, medianLeadHours: round1(median(lead)) }));
}

export interface ComputeOptions {
  windowDays: number;
  /** "Now" — injectable for tests. */
  now?: Date;
}

/**
 * Compute all DORA metrics for one repo over a trailing window. Callers pass whatever items they
 * have; this function applies the window filter itself (by `mergedAt` for PRs, `createdAt` for
 * incidents) so the API and the overview endpoint share one code path.
 */
export function computeDora(
  allPrs: readonly PrForMetrics[],
  allIssues: readonly IssueForMetrics[],
  opts: ComputeOptions,
): DoraMetrics {
  const now = opts.now ?? new Date();
  const days = Math.max(1, Math.floor(opts.windowDays));
  const from = new Date(now.getTime() - days * DAY);
  const fromIso = from.toISOString();
  const toIso = now.toISOString();

  const prs = allPrs.filter((p) => p.mergedAt >= fromIso && p.mergedAt <= toIso);
  const issues = allIssues.filter((i) => i.createdAt >= fromIso && i.createdAt <= toIso);

  const split = <T>(f: (cohortPrs: PrForMetrics[], cohort: Cohort) => T): Split<T> => ({
    all: f(prs, 'all'),
    ai: f(prs.filter((p) => inCohort(p, 'ai')), 'ai'),
    human: f(prs.filter((p) => inCohort(p, 'human')), 'human'),
  });

  const byAssistant: DoraMetrics['byAssistant'] = { 'claude-code': 0, kiro: 0, 'amazon-q': 0, copilot: 0 };
  for (const p of prs) if (p.assistedBy) byAssistant[p.assistedBy] += 1;
  const aiCount = prs.filter((p) => p.assistedBy).length;

  return {
    deploymentFrequency: split((c) => deploymentFrequency(c, days)),
    leadTime: split((c) => leadTime(c)),
    // Incidents can't be attributed to a cohort → only the `all` cohort counts them.
    changeFailureRate: split((c, cohort) => changeFailureRate(c, cohort === 'all' ? issues.length : 0)),
    mttr: split((c, cohort) => mttr(c, cohort === 'all' ? issues : [])),
    aiParticipationPct: prs.length === 0 ? null : round1((aiCount / prs.length) * 100),
    byAssistant,
    timeline: timeline(prs, issues, from, now),
    sample: { mergedPrs: prs.length, incidents: issues.length, windowDays: days, from: fromIso, to: toIso },
  };
}
