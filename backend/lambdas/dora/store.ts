/**
 * DynamoDB access for the DORA table (`DORA_TABLE`). One table, generic pk/sk:
 *   REPO / owner-name            → registry (admin-managed target repos)
 *   PR#owner/name / mergedAt#n   → merged PRs (time-ordered → range query per window)
 *   ISSUE#owner/name / created#n → incident-class issues
 *   META / seed                  → config seed applied marker
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  BatchWriteCommand, DeleteCommand, DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { IssueItem, MetaSeedItem, PrItem, REPO_PK, RepoItem, SyncStatus, issuePk, prPk, prSk } from './types';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } });
const TABLE = () => process.env.DORA_TABLE!;

/** Registry key: lower-cased so "Owner/Name" and "owner/name" are the same repo. */
export const repoKey = (repo: string) => repo.trim().toLowerCase();

export async function listRepos(): Promise<RepoItem[]> {
  const out: RepoItem[] = [];
  let key: Record<string, unknown> | undefined;
  do {
    const res = await ddb.send(new QueryCommand({
      TableName: TABLE(),
      KeyConditionExpression: 'pk = :pk',
      ExpressionAttributeValues: { ':pk': REPO_PK },
      ExclusiveStartKey: key,
    }));
    out.push(...((res.Items ?? []) as RepoItem[]));
    key = res.LastEvaluatedKey;
  } while (key);
  return out.sort((a, b) => a.sk.localeCompare(b.sk));
}

export async function getRepo(repo: string): Promise<RepoItem | null> {
  const res = await ddb.send(new GetCommand({ TableName: TABLE(), Key: { pk: REPO_PK, sk: repoKey(repo) } }));
  return (res.Item as RepoItem | undefined) ?? null;
}

export async function putRepo(item: RepoItem): Promise<void> {
  await ddb.send(new PutCommand({ TableName: TABLE(), Item: item }));
}

/** Idempotent create: no-op if the repo is already registered. Returns true when created. */
export async function createRepoIfAbsent(item: RepoItem): Promise<boolean> {
  try {
    await ddb.send(new PutCommand({
      TableName: TABLE(), Item: item, ConditionExpression: 'attribute_not_exists(pk)',
    }));
    return true;
  } catch (err) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') return false;
    throw err;
  }
}

export interface SyncUpdate {
  lastSyncStatus: SyncStatus;
  lastSyncedAt?: string;
  lastSyncError?: string | null;
  watermarkPrUpdatedAt?: string;
  watermarkIssuesSince?: string;
  prCount?: number;
  incidentCount?: number;
  defaultBranch?: string;
}

export async function updateRepoSync(repo: string, u: SyncUpdate): Promise<void> {
  const sets: string[] = [];
  const removes: string[] = [];
  const names: Record<string, string> = {};
  const values: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(u)) {
    if (v === undefined) continue;
    names[`#${k}`] = k;
    if (v === null) { removes.push(`#${k}`); continue; }
    sets.push(`#${k} = :${k}`);
    values[`:${k}`] = v;
  }
  if (!sets.length && !removes.length) return;
  await ddb.send(new UpdateCommand({
    TableName: TABLE(),
    Key: { pk: REPO_PK, sk: repoKey(repo) },
    UpdateExpression: [sets.length ? `SET ${sets.join(', ')}` : '', removes.length ? `REMOVE ${removes.join(', ')}` : ''].filter(Boolean).join(' '),
    ExpressionAttributeNames: names,
    ...(Object.keys(values).length ? { ExpressionAttributeValues: values } : {}),
    ConditionExpression: 'attribute_exists(pk)',
  }));
}

export async function getPr(repo: string, mergedAt: string, number: number): Promise<PrItem | null> {
  const res = await ddb.send(new GetCommand({ TableName: TABLE(), Key: { pk: prPk(repo), sk: prSk(mergedAt, number) } }));
  return (res.Item as PrItem | undefined) ?? null;
}

export async function putPr(item: PrItem): Promise<void> {
  await ddb.send(new PutCommand({ TableName: TABLE(), Item: item }));
}

export async function putIssue(item: IssueItem): Promise<void> {
  await ddb.send(new PutCommand({ TableName: TABLE(), Item: item }));
}

async function queryRange<T>(pk: string, fromIso?: string): Promise<T[]> {
  const out: T[] = [];
  let key: Record<string, unknown> | undefined;
  do {
    const res = await ddb.send(new QueryCommand({
      TableName: TABLE(),
      KeyConditionExpression: fromIso ? 'pk = :pk AND sk >= :from' : 'pk = :pk',
      ExpressionAttributeValues: fromIso ? { ':pk': pk, ':from': fromIso } : { ':pk': pk },
      ExclusiveStartKey: key,
    }));
    out.push(...((res.Items ?? []) as T[]));
    key = res.LastEvaluatedKey;
  } while (key);
  return out;
}

/** Merged PRs with mergedAt ≥ fromIso (sk is `${mergedAt}#…`, so a plain range works). */
export const queryPrs = (repo: string, fromIso?: string) => queryRange<PrItem>(prPk(repo), fromIso);
export const queryIssues = (repo: string, fromIso?: string) => queryRange<IssueItem>(issuePk(repo), fromIso);

/** All PR keys for a repo (any time) — used for counting and cascade delete. */
async function keysFor(pk: string): Promise<Array<{ pk: string; sk: string }>> {
  const out: Array<{ pk: string; sk: string }> = [];
  let key: Record<string, unknown> | undefined;
  do {
    const res = await ddb.send(new QueryCommand({
      TableName: TABLE(),
      KeyConditionExpression: 'pk = :pk',
      ExpressionAttributeValues: { ':pk': pk },
      ProjectionExpression: 'pk, sk',
      ExclusiveStartKey: key,
    }));
    out.push(...((res.Items ?? []) as Array<{ pk: string; sk: string }>));
    key = res.LastEvaluatedKey;
  } while (key);
  return out;
}

export async function countItems(repo: string): Promise<{ prCount: number; incidentCount: number }> {
  const [prs, issues] = await Promise.all([keysFor(prPk(repo)), keysFor(issuePk(repo))]);
  return { prCount: prs.length, incidentCount: issues.length };
}

/** Remove the registry item and every PR / issue item for the repo. Returns items deleted. */
export async function deleteRepoCascade(repo: string): Promise<number> {
  const keys = [...(await keysFor(prPk(repo))), ...(await keysFor(issuePk(repo)))];
  for (let i = 0; i < keys.length; i += 25) {
    let batch: Record<string, unknown[]> = { [TABLE()]: keys.slice(i, i + 25).map((Key) => ({ DeleteRequest: { Key } })) };
    // Retry unprocessed items (throughput hiccups) a few times.
    for (let attempt = 0; attempt < 5 && Object.keys(batch).length; attempt++) {
      const res = await ddb.send(new BatchWriteCommand({ RequestItems: batch as never }));
      batch = (res.UnprocessedItems ?? {}) as Record<string, unknown[]>;
      if (Object.keys(batch).length) await new Promise((r) => setTimeout(r, 200 * (attempt + 1)));
    }
  }
  await ddb.send(new DeleteCommand({ TableName: TABLE(), Key: { pk: REPO_PK, sk: repoKey(repo) } }));
  return keys.length + 1;
}

export async function getSeedMarker(): Promise<MetaSeedItem | null> {
  const res = await ddb.send(new GetCommand({ TableName: TABLE(), Key: { pk: 'META', sk: 'seed' } }));
  return (res.Item as MetaSeedItem | undefined) ?? null;
}

export async function putSeedMarker(repos: string[]): Promise<void> {
  const item: MetaSeedItem = { pk: 'META', sk: 'seed', seededAt: new Date().toISOString(), repos };
  await ddb.send(new PutCommand({ TableName: TABLE(), Item: item }));
}
