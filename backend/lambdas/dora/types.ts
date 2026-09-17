/**
 * Shared types for the DORA metrics feature (per-repo delivery performance for repos built by
 * humans + AI coding assistants). Storage is one DynamoDB table (`DORA_TABLE`) with generic
 * pk/sk keys; metrics are computed on read from the raw PR / issue items below.
 *
 * "Deployment" is defined as a PR merged to the repo's default branch — none of the tracked repos
 * use the GitHub Deployments API, and this is also the reference implementation's fallback.
 */

/** Which AI coding assistant (if any) participated in a PR. */
export type AssistedBy = 'claude-code' | 'kiro' | 'amazon-q' | 'copilot' | null;

/** Sync state of one tracked repo, surfaced to the dashboard. */
export type SyncStatus =
  | 'pending'
  | 'syncing'
  | 'ok'
  | 'rate-limited'
  | 'token-not-configured'
  | 'error';

/** Registry item: pk = 'REPO', sk = 'owner/name' (lower-cased). */
export interface RepoItem {
  pk: 'REPO';
  sk: string;
  type: 'repo';
  /** Canonical "owner/name" as GitHub reports it (case preserved for display). */
  repo: string;
  owner: string;
  name: string;
  defaultBranch: string;
  /** Email of the admin who added it, or 'seed' for config-seeded repos. */
  addedBy: string;
  addedAt: string;
  /** ISO timestamp; PRs merged before this are not collected. */
  backfillFrom: string;
  /** Incremental-sync cursors (ISO). Absent until the first successful sync. */
  watermarkPrUpdatedAt?: string;
  watermarkIssuesSince?: string;
  lastSyncedAt?: string;
  lastSyncStatus: SyncStatus;
  lastSyncError?: string;
  prCount: number;
  incidentCount: number;
}

/** One merged PR: pk = `PR#owner/name`, sk = `${mergedAt}#${number padded to 6}`. */
export interface PrItem {
  pk: string;
  sk: string;
  type: 'pr';
  number: number;
  title: string;
  author: string;
  headRef: string;
  labels: string[];
  createdAt: string;
  mergedAt: string;
  /** Earliest commit author date across the PR's commits (start of "lead time"). */
  firstCommitAt: string;
  /** GitHub `updated_at` at collection time — used to skip unchanged PRs on re-sync. */
  prUpdatedAt: string;
  commitCount: number;
  isRevert: boolean;
  isHotfix: boolean;
  assistedBy: AssistedBy;
  /** Which signals fired (e.g. 'trailer:claude', 'body:kiro', 'author:bot') — for debugging. */
  aiSignals: string[];
  htmlUrl: string;
}

/** Incident-class issue (labelled bug/incident): pk = `ISSUE#owner/name`, sk = `${createdAt}#${number}`. */
export interface IssueItem {
  pk: string;
  sk: string;
  type: 'issue';
  number: number;
  title: string;
  labels: string[];
  createdAt: string;
  closedAt: string | null;
  htmlUrl: string;
}

/** Marks that the config seed list has been applied once (so admins deleting repos don't re-seed). */
export interface MetaSeedItem {
  pk: 'META';
  sk: 'seed';
  seededAt: string;
  repos: string[];
}

export const REPO_PK = 'REPO';
export const prPk = (repo: string) => `PR#${repo.toLowerCase()}`;
export const issuePk = (repo: string) => `ISSUE#${repo.toLowerCase()}`;
export const prSk = (mergedAt: string, number: number) => `${mergedAt}#${String(number).padStart(6, '0')}`;
export const issueSk = (createdAt: string, number: number) => `${createdAt}#${String(number).padStart(6, '0')}`;

/** Fields of a PR needed by the metric math (subset of PrItem, so tests can use small fixtures). */
export type PrForMetrics = Pick<
  PrItem,
  'number' | 'createdAt' | 'mergedAt' | 'firstCommitAt' | 'isRevert' | 'isHotfix' | 'assistedBy'
>;

/** Fields of an issue needed by the metric math. */
export type IssueForMetrics = Pick<IssueItem, 'number' | 'createdAt' | 'closedAt'>;
