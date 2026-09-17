import { buildProjectRows, projdayRange, ProjdayItem } from './project-calc';
import { PrForMetrics } from '../dora/types';
import { RegistryProject, PROJECT_PK } from '../shared/project-registry';

const NOW = new Date('2026-09-17T12:00:00.000Z');
const H = 3_600_000;
const iso = (hoursAgo: number) => new Date(NOW.getTime() - hoursAgo * H).toISOString();

let n = 0;
const pr = (mergedHoursAgo: number, assistedBy: PrForMetrics['assistedBy'] = null): PrForMetrics => ({
  number: ++n,
  mergedAt: iso(mergedHoursAgo),
  createdAt: iso(mergedHoursAgo + 2),
  firstCommitAt: iso(mergedHoursAgo + 5),
  isRevert: false,
  isHotfix: false,
  assistedBy,
});
const project = (o: Partial<RegistryProject>): RegistryProject => ({
  pk: PROJECT_PK, sk: o.projectId ?? 'p', type: 'project',
  projectId: 'p', name: 'P', repos: [], identityArns: [], addedBy: 't', addedAt: iso(0), ...o,
});
const day = (dayStr: string, projectId: string, modelId: string, inTok: number, outTok: number, cache = 0): ProjdayItem =>
  ({ day: dayStr, projectId, modelId, inputTokens: inTok, outputTokens: outTok, cacheReadTokens: cache, invocations: 1 });

const OPTS = { windowDays: 30, now: NOW, doraTrackedRepos: new Set(['o/a', 'o/b']) };

describe('projdayRange', () => {
  it('produces inclusive day bounds with a high sk sentinel', () => {
    const r = projdayRange(NOW, 30);
    expect(r.toDay).toBe('2026-09-17');
    expect(r.fromDay).toBe('2026-08-18');
    expect(r.fromSk).toBe('2026-08-18');
    expect(r.toSk > '2026-09-17#zzzz').toBe(true); // ￿ sorts after any projectId#modelId
  });
});

describe('buildProjectRows', () => {
  it('pools DORA across a project\'s repos', () => {
    const rows = buildProjectRows(
      [project({ projectId: 'p1', name: 'One', repos: ['o/a', 'o/b'] })],
      new Map([['o/a', [pr(10), pr(20)]], ['o/b', [pr(30, 'claude-code')]]]),
      new Map(),
      [],
      OPTS,
    );
    expect(rows[0].dora).toMatchObject({ mergedPrs: 3 });
    expect(rows[0].dora!.df.n).toBe(3);
    expect(rows[0].dora!.aiParticipationPct).toBeCloseTo(33.3, 1);
    // The ordinal band travels with the rate: the Projects table leads with the phrase, so a
    // silently dropped `band` would show every project as "—" while the rate looked fine.
    expect(rows[0].dora!.df.band).toBe('Between once per week and once per month');
  });

  it('notes untracked repos and computes DORA from the tracked subset', () => {
    const rows = buildProjectRows(
      [project({ projectId: 'p1', name: 'One', repos: ['o/a', 'o/zzz'] })],
      new Map([['o/a', [pr(10)]]]),
      new Map(),
      [],
      OPTS,
    );
    expect(rows[0].notes).toContain('repo o/zzz is not tracked in DORA');
    expect(rows[0].dora!.mergedPrs).toBe(1);
  });

  it('project with no repos → dora null, cost still summed', () => {
    const rows = buildProjectRows(
      [project({ projectId: 'p2', name: 'CostOnly', costCenter: 'CC-1' })],
      new Map(), new Map(),
      [day('2026-09-10', 'p2', 'us.anthropic.claude-sonnet-4-6', 1_000_000, 100_000)],
      OPTS,
    );
    expect(rows[0].dora).toBeNull();
    expect(rows[0].notes).toContain('no repos linked — cost only');
    expect(rows[0].tokens).toBe(1_100_000);
    // sonnet: 1M×3e-6 + 0.1M×15e-6 = 3 + 1.5 = 4.5
    expect(rows[0].estimatedUsd).toBeCloseTo(4.5, 6);
    expect(rows[0].usdPerMergedPr).toBeNull();
  });

  it('prices per model — sonnet vs haiku rows differ, ARN model ids normalize', () => {
    const rows = buildProjectRows(
      [project({ projectId: 'p3', name: 'Mixed' })],
      new Map(), new Map(),
      [
        day('2026-09-10', 'p3', 'arn:aws:bedrock:us-east-1:1:inference-profile/us.anthropic.claude-sonnet-4-6', 1_000_000, 0),
        day('2026-09-11', 'p3', 'us.anthropic.claude-haiku-4-5', 1_000_000, 0),
      ],
      OPTS,
    );
    // sonnet 1M×3e-6=3.0 + haiku 1M×1e-6=1.0
    expect(rows[0].estimatedUsd).toBeCloseTo(4.0, 6);
  });

  it('derives $/deployment = $/merged PR and flags empty windows', () => {
    const rows = buildProjectRows(
      [project({ projectId: 'p4', name: 'Full', repos: ['o/a'] })],
      new Map([['o/a', [pr(5), pr(6)]]]),
      new Map(),
      [day('2026-09-15', 'p4', 'us.anthropic.claude-sonnet-4-6', 2_000_000, 0)],
      OPTS,
    );
    expect(rows[0].estimatedUsd).toBeCloseTo(6.0, 6);
    expect(rows[0].usdPerDeployment).toBeCloseTo(3.0, 2);
    expect(rows[0].usdPerMergedPr).toBe(rows[0].usdPerDeployment);
    expect(rows[0].notes).toHaveLength(0);

    const empty = buildProjectRows([project({ projectId: 'p5', name: 'Idle', repos: ['o/a'] })], new Map(), new Map(), [], OPTS);
    expect(empty[0].notes).toContain('no usage recorded in window');
    expect(empty[0].tokens).toBe(0);
  });
});
