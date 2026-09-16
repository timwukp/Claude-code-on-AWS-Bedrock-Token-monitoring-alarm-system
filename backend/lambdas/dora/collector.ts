/**
 * Scheduled / on-demand collector: pulls merged PRs (+ their commits) and incident-class issues
 * from GitHub for every registered repo and stores them in the DORA table. Incremental via a
 * per-repo `updated_at` watermark; the first run for a repo backfills `DORA_BACKFILL_DAYS`.
 *
 * Invoked (a) by an EventBridge schedule with an empty event, (b) asynchronously by the API
 * after an admin adds a repo or clicks "Sync now" (`{ repo: "owner/name" }`), or (c) locally via
 * `backend/scripts/run-dora-collector-once.ts`.
 *
 * Env: DORA_TABLE, GITHUB_TOKEN_SECRET_NAME, DORA_SEED_REPOS (comma list), DORA_BACKFILL_DAYS.
 */
import { detectAssistedBy, isHotfixPr, isIncidentIssue, isRevertPr } from './dora-classify';
import {
  GhCommit, GhIssue, GhPull, GhRepo, GithubClient, RateLimitedError, createGithubClient,
} from './github-client';
import { loadGithubToken } from './secret';
import * as store from './store';
import { IssueItem, PrItem, REPO_PK, RepoItem, issuePk, issueSk, prPk, prSk } from './types';

export interface CollectorEvent { repo?: string }
export interface CollectorResult {
  synced: string[];
  skipped: string[];
  failed: string[];
  rateLimited: boolean;
  tokenConfigured: boolean;
}

const DAY = 86_400_000;
const backfillDays = () => Number(process.env.DORA_BACKFILL_DAYS ?? '180') || 180;

/** Build a registry item for a newly-added repo (used by both seeding and the admin API). */
export function newRepoItem(repo: GhRepo | { full_name: string; default_branch?: string }, addedBy: string, now = new Date()): RepoItem {
  const [owner, name] = repo.full_name.split('/');
  return {
    pk: REPO_PK,
    sk: store.repoKey(repo.full_name),
    type: 'repo',
    repo: repo.full_name,
    owner,
    name,
    defaultBranch: repo.default_branch ?? 'main',
    addedBy,
    addedAt: now.toISOString(),
    backfillFrom: new Date(now.getTime() - backfillDays() * DAY).toISOString(),
    lastSyncStatus: 'pending',
    prCount: 0,
    incidentCount: 0,
  };
}

/** Apply the config seed list once (no-op after that, even if admins delete every repo). */
export async function seedIfNeeded(): Promise<string[]> {
  const seeds = (process.env.DORA_SEED_REPOS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!seeds.length) return [];
  if (await store.getSeedMarker()) return [];
  const existing = await store.listRepos();
  if (existing.length) { await store.putSeedMarker(seeds); return []; }
  const created: string[] = [];
  for (const full of seeds) {
    if (await store.createRepoIfAbsent(newRepoItem({ full_name: full }, 'seed'))) created.push(full);
  }
  await store.putSeedMarker(seeds);
  console.log('dora: seeded repos', created);
  return created;
}

export function toPrItem(repo: string, pr: GhPull, commits: GhCommit[]): PrItem {
  const mergedAt = pr.merged_at!;
  const commitDates = commits
    .map((c) => c.commit.author?.date ?? c.commit.committer?.date)
    .filter((d): d is string => !!d)
    .sort();
  const firstCommitAt = commitDates[0] ?? pr.created_at;
  const labels = pr.labels.map((l) => l.name);
  const ai = detectAssistedBy({ author: pr.user?.login, body: pr.body, commitMessages: commits.map((c) => c.commit.message) });
  return {
    pk: prPk(repo),
    sk: prSk(mergedAt, pr.number),
    type: 'pr',
    number: pr.number,
    title: pr.title,
    author: pr.user?.login ?? 'unknown',
    headRef: pr.head.ref,
    labels,
    createdAt: pr.created_at,
    mergedAt,
    firstCommitAt,
    prUpdatedAt: pr.updated_at,
    commitCount: commits.length,
    isRevert: isRevertPr(pr.title, labels),
    isHotfix: isHotfixPr(pr.title, pr.head.ref, labels),
    assistedBy: ai.assistedBy,
    aiSignals: ai.signals,
    htmlUrl: pr.html_url,
  };
}

export function toIssueItem(repo: string, issue: GhIssue): IssueItem {
  return {
    pk: issuePk(repo),
    sk: issueSk(issue.created_at, issue.number),
    type: 'issue',
    number: issue.number,
    title: issue.title,
    labels: issue.labels.map((l) => l.name),
    createdAt: issue.created_at,
    closedAt: issue.closed_at,
    htmlUrl: issue.html_url,
  };
}

/** Sync one repo. Throws RateLimitedError so the caller can stop the whole run. */
export async function syncRepo(gh: GithubClient, repo: RepoItem, runStart: Date): Promise<{ prs: number; issues: number }> {
  const full = repo.repo;
  const since = repo.watermarkPrUpdatedAt ?? repo.backfillFrom;
  await store.updateRepoSync(full, { lastSyncStatus: 'syncing', lastSyncError: null });

  // Refresh the default branch so PRs merged into it are recognised even if it was renamed.
  const meta = await gh.getJson<GhRepo>(`/repos/${full}`);
  const defaultBranch = meta.data.default_branch;

  // Closed PRs newest-updated first; stop paging once we're past the watermark.
  const pulls = await gh.paginate<GhPull>(
    `/repos/${full}/pulls?state=closed&sort=updated&direction=desc&per_page=100&base=${encodeURIComponent(defaultBranch)}`,
    (page) => page.some((p) => p.updated_at < since),
  );
  let prsWritten = 0;
  for (const pr of pulls) {
    if (pr.updated_at < since) continue;
    if (!pr.merged_at || pr.merged_at < repo.backfillFrom) continue;
    const existing = await store.getPr(full, pr.merged_at, pr.number);
    if (existing && existing.prUpdatedAt === pr.updated_at) continue;
    const commits = await gh.paginate<GhCommit>(`/repos/${full}/pulls/${pr.number}/commits?per_page=100`, undefined, 3);
    await store.putPr(toPrItem(full, pr, commits));
    prsWritten += 1;
  }

  // Incident-class issues. GitHub's `labels=` is AND, so query each label separately.
  const issuesSince = repo.watermarkIssuesSince ?? repo.backfillFrom;
  let issuesWritten = 0;
  const seen = new Set<number>();
  for (const label of ['bug', 'incident']) {
    const issues = await gh.paginate<GhIssue>(
      `/repos/${full}/issues?state=all&labels=${label}&since=${encodeURIComponent(issuesSince)}&per_page=100`,
    );
    for (const issue of issues) {
      if (seen.has(issue.number) || !isIncidentIssue({ labels: issue.labels.map((l) => l.name), pull_request: issue.pull_request })) continue;
      if (issue.created_at < repo.backfillFrom) continue;
      seen.add(issue.number);
      await store.putIssue(toIssueItem(full, issue));
      issuesWritten += 1;
    }
  }

  // Advance the watermark slightly behind "now" to tolerate clock skew / late index updates.
  const watermark = new Date(runStart.getTime() - 5 * 60_000).toISOString();
  const counts = await store.countItems(full);
  await store.updateRepoSync(full, {
    lastSyncStatus: 'ok',
    lastSyncedAt: new Date().toISOString(),
    lastSyncError: null,
    watermarkPrUpdatedAt: watermark,
    watermarkIssuesSince: watermark,
    defaultBranch,
    ...counts,
  });
  return { prs: prsWritten, issues: issuesWritten };
}

export const handler = async (event: CollectorEvent = {}): Promise<CollectorResult> => {
  const runStart = new Date();
  const result: CollectorResult = { synced: [], skipped: [], failed: [], rateLimited: false, tokenConfigured: true };

  await seedIfNeeded();
  let repos = await store.listRepos();
  if (event.repo) {
    const key = store.repoKey(event.repo);
    repos = repos.filter((r) => r.sk === key);
    if (!repos.length) { console.warn('dora: sync requested for unknown repo', event.repo); return result; }
  }

  const token = await loadGithubToken();
  if (!token) {
    result.tokenConfigured = false;
    for (const r of repos) {
      await store.updateRepoSync(r.repo, { lastSyncStatus: 'token-not-configured', lastSyncError: 'Set the GitHub token secret, then sync again.' });
      result.skipped.push(r.repo);
    }
    console.warn('dora: GitHub token not configured — nothing collected');
    return result;
  }

  const gh = createGithubClient(token);
  for (const repo of repos) {
    try {
      const n = await syncRepo(gh, repo, runStart);
      console.log(`dora: synced ${repo.repo} — ${n.prs} PRs, ${n.issues} issues written (remaining ${gh.remaining})`);
      result.synced.push(repo.repo);
    } catch (err) {
      if (err instanceof RateLimitedError) {
        result.rateLimited = true;
        await store.updateRepoSync(repo.repo, { lastSyncStatus: 'rate-limited', lastSyncError: err.message });
        result.skipped.push(repo.repo);
        console.warn('dora: rate limited; stopping run', err.message);
        // Remaining repos stay as they were; the next scheduled run resumes from their watermarks.
        for (const rest of repos.slice(repos.indexOf(repo) + 1)) result.skipped.push(rest.repo);
        break;
      }
      const message = (err as Error).message ?? String(err);
      console.error('dora: sync failed for', repo.repo, message);
      await store.updateRepoSync(repo.repo, { lastSyncStatus: 'error', lastSyncError: message.slice(0, 500) });
      result.failed.push(repo.repo);
    }
  }
  return result;
};
