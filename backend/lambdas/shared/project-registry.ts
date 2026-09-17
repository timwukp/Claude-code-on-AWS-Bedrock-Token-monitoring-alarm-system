/**
 * Project registry on the tums-tenants table (#13): projects (name, cost center, repos,
 * identity hints), a cache of application-inference-profile → project resolutions, and a
 * config-seed marker. Shared between the ingestion aggregator (reads maps, writes profile
 * cache) and the API lambdas (registry CRUD, project↔DORA join).
 *
 * Key spaces (pk / sk):
 *   REGISTRY#PROJECT  / <projectId>            — one item per project
 *   REGISTRY#PROFILE  / <full AIP ARN>         — resolved (or negative-cached) profiles
 *   REGISTRY#IDENTITY / <identity arn, lower>  — caller-ARN → project hints
 *   REGISTRY#META     / projects-seed          — config seed applied marker
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DeleteCommand, DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand,
} from '@aws-sdk/lib-dynamodb';
import { AttributionMaps } from '../ingestion/parse';
import { RoiAssumptions } from '../api/roi-calc';

/** Per-project ROI assumptions (#14) — all optional; org defaults + code defaults fill gaps. */
export type ProjectRoiConfig = Partial<Pick<RoiAssumptions,
  'teamSize' | 'loadedCostPerYear' | 'netTimeSavedPct' | 'ideaSuccessRate' |
  'revenueImpactPerFeature' | 'revenueBase' | 'downtimeCostPerHour' | 'trainingCostPerUser' |
  'jCurve' | 'baseline' | 'category'>>;

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } });
const TABLE = () => process.env.TENANTS_TABLE!;

export const PROJECT_PK = 'REGISTRY#PROJECT';
export const PROFILE_PK = 'REGISTRY#PROFILE';
export const IDENTITY_PK = 'REGISTRY#IDENTITY';

export interface RegistryProject {
  pk: typeof PROJECT_PK;
  sk: string; // projectId
  type: 'project';
  projectId: string;
  name: string;
  costCenter?: string;
  /** "owner/name", lower-cased — join key into the DORA repo registry. */
  repos: string[];
  /** Caller ARNs (lower-cased) attributed to this project when no stronger signal exists. */
  identityArns: string[];
  addedBy: string;
  addedAt: string;
  seededBy?: 'config';
  /** ROI assumptions (#14); absent fields fall back to org defaults then code defaults. */
  roi?: ProjectRoiConfig;
}

export interface ProfileCacheItem {
  pk: typeof PROFILE_PK;
  sk: string; // full AIP ARN
  type: 'profile';
  arn: string;
  /** 'untagged' marks a negative cache entry (profile without a usable project tag). */
  projectId: string;
  /** Normalized underlying model id (matches the rate card), e.g. us.anthropic.claude-sonnet-4-6. */
  underlyingModelId: string;
  profileName?: string;
  source: 'runtime-resolve';
  resolvedAt: string;
  /** Present on negative-cache entries: epoch ms after which resolution is retried. */
  retryAfterMs?: number;
}

export interface IdentityHintItem {
  pk: typeof IDENTITY_PK;
  sk: string; // identity arn, lower-cased
  type: 'identity';
  identityArn: string;
  projectId: string;
  addedBy: string;
  addedAt: string;
}

export interface SeedProject {
  id: string;
  name: string;
  costCenter?: string;
  repos?: string[];
  models?: string[]; // used by CDK only; ignored at runtime
  identityArns?: string[];
}

// ---------- pure helpers (unit-tested) ----------

export const PROJECT_ID_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;
const REPO_RE = /^[\w.-]+\/[\w.-]+$/;

export interface ProjectInput {
  id?: unknown;
  name?: unknown;
  costCenter?: unknown;
  repos?: unknown;
  identityArns?: unknown;
  roi?: unknown;
}

const ROI_CATEGORIES = ['product', 'chore', 'experiment'] as const;

/** Validate a partial ROI-assumptions object (admin input). Pure. */
export function validateRoiConfig(input: unknown): { roi?: ProjectRoiConfig; error?: string } {
  if (input == null) return {};
  if (typeof input !== 'object' || Array.isArray(input)) return { error: 'roi must be an object' };
  const o = input as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  const num = (k: string, lo: number, hi: number, integer = false): string | null => {
    if (o[k] === undefined || o[k] === null || o[k] === '') return null;
    const n = Number(o[k]);
    if (!Number.isFinite(n) || n < lo || n > hi || (integer && !Number.isInteger(n))) {
      return `roi.${k} must be ${integer ? 'an integer ' : ''}in [${lo}, ${hi}]`;
    }
    out[k] = n;
    return null;
  };
  for (const err of [
    num('teamSize', 1, 10_000, true),
    num('loadedCostPerYear', 1_000, 5_000_000),
    num('netTimeSavedPct', -100, 200),
    num('ideaSuccessRate', 0, 1),
    num('revenueImpactPerFeature', 0.0001, 0.01),
    num('revenueBase', 0, 1e12),
    num('downtimeCostPerHour', 0, 1e8),
    num('trainingCostPerUser', 0, 1e6),
  ]) if (err) return { error: err };
  if (o.category !== undefined) {
    if (!ROI_CATEGORIES.includes(o.category as never)) return { error: `roi.category must be one of ${ROI_CATEGORIES.join(', ')}` };
    out.category = o.category;
  }
  if (o.jCurve !== undefined && o.jCurve !== null) {
    const j = o.jCurve as Record<string, unknown>;
    const drop = Number(j.dropPct ?? 15); const months = Number(j.months ?? 3);
    if (!Number.isFinite(drop) || drop < 0 || drop > 100) return { error: 'roi.jCurve.dropPct must be in [0, 100]' };
    if (!Number.isFinite(months) || months < 0 || months > 24) return { error: 'roi.jCurve.months must be in [0, 24]' };
    out.jCurve = { include: !!j.include, dropPct: drop, months };
  }
  if (o.baseline !== undefined && o.baseline !== null) {
    const b = o.baseline as Record<string, unknown>;
    const d = Number(b.deploymentsPerYear); const c = Number(b.cfrPct); const m = Number(b.mttrHours);
    if (![d, c, m].every(Number.isFinite) || d < 0 || c < 0 || c > 100 || m < 0) {
      return { error: 'roi.baseline needs numeric deploymentsPerYear, cfrPct [0-100], mttrHours ≥ 0' };
    }
    out.baseline = { deploymentsPerYear: d, cfrPct: c, mttrHours: m };
  }
  return { roi: out as ProjectRoiConfig };
}

/** Validate + normalize an admin-supplied project. Returns the item fields or a message. */
export function validateProject(
  input: ProjectInput,
  addedBy: string,
  now = new Date(),
): { project?: RegistryProject; error?: string } {
  const id = String(input.id ?? '').trim().toLowerCase();
  if (!PROJECT_ID_RE.test(id)) return { error: 'id must match ^[a-z0-9][a-z0-9-]{1,63}$' };
  const name = String(input.name ?? '').trim();
  if (!name) return { error: 'name is required' };
  const rawRepos = Array.isArray(input.repos) ? input.repos : [];
  const repos: string[] = [];
  for (const r of rawRepos) {
    const repo = String(r).trim().toLowerCase();
    if (!repo) continue;
    if (!REPO_RE.test(repo)) return { error: `repo "${repo}" must look like "owner/name"` };
    if (!repos.includes(repo)) repos.push(repo);
  }
  const rawIds = Array.isArray(input.identityArns) ? input.identityArns : [];
  const identityArns = [...new Set(rawIds.map((a) => String(a).trim().toLowerCase()).filter(Boolean))];
  const costCenter = String(input.costCenter ?? '').trim() || undefined;
  const { roi, error: roiError } = validateRoiConfig(input.roi);
  if (roiError) return { error: roiError };
  return {
    project: {
      pk: PROJECT_PK, sk: id, type: 'project',
      projectId: id, name, costCenter, repos, identityArns,
      addedBy, addedAt: now.toISOString(),
      ...(roi && Object.keys(roi).length ? { roi } : {}),
    },
  };
}

/** Whether the config seed should be applied (once, and only into an empty registry). */
export function shouldSeed(markerExists: boolean, existingProjects: number, seeds: SeedProject[]): boolean {
  return !markerExists && seeds.length > 0 && existingProjects === 0;
}

/** Parse the PROJECTS_SEED_JSON env var defensively. */
export function parseSeedJson(raw: string | undefined): SeedProject[] {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? (arr as SeedProject[]).filter((p) => p && p.id && p.name) : [];
  } catch {
    console.warn('project-registry: PROJECTS_SEED_JSON is not valid JSON — ignoring');
    return [];
  }
}

// ---------- DynamoDB access ----------

async function queryAll<T>(pk: string): Promise<T[]> {
  const out: T[] = [];
  let key: Record<string, unknown> | undefined;
  do {
    const res = await ddb.send(new QueryCommand({
      TableName: TABLE(),
      KeyConditionExpression: 'pk = :pk',
      ExpressionAttributeValues: { ':pk': pk },
      ExclusiveStartKey: key,
    }));
    out.push(...((res.Items ?? []) as T[]));
    key = res.LastEvaluatedKey;
  } while (key);
  return out;
}

export const listProjects = async (): Promise<RegistryProject[]> =>
  (await queryAll<RegistryProject>(PROJECT_PK)).sort((a, b) => a.sk.localeCompare(b.sk));

export async function getProject(id: string): Promise<RegistryProject | null> {
  const res = await ddb.send(new GetCommand({ TableName: TABLE(), Key: { pk: PROJECT_PK, sk: id.toLowerCase() } }));
  return (res.Item as RegistryProject | undefined) ?? null;
}

/** Upsert a project and (re)write its identity-hint items. */
export async function putProject(p: RegistryProject): Promise<void> {
  const existing = await getProject(p.projectId);
  await ddb.send(new PutCommand({ TableName: TABLE(), Item: p }));
  // Remove hints that no longer apply, then write the current set.
  for (const arn of existing?.identityArns ?? []) {
    if (!p.identityArns.includes(arn)) {
      await ddb.send(new DeleteCommand({ TableName: TABLE(), Key: { pk: IDENTITY_PK, sk: arn } }));
    }
  }
  for (const arn of p.identityArns) {
    const item: IdentityHintItem = {
      pk: IDENTITY_PK, sk: arn, type: 'identity',
      identityArn: arn, projectId: p.projectId, addedBy: p.addedBy, addedAt: p.addedAt,
    };
    await ddb.send(new PutCommand({ TableName: TABLE(), Item: item }));
  }
}

/** Delete a project, its identity hints, and its cached profile resolutions. */
export async function deleteProjectCascade(id: string): Promise<number> {
  const project = await getProject(id);
  if (!project) return 0;
  let deleted = 0;
  for (const arn of project.identityArns) {
    await ddb.send(new DeleteCommand({ TableName: TABLE(), Key: { pk: IDENTITY_PK, sk: arn } }));
    deleted++;
  }
  for (const prof of await listProfiles()) {
    if (prof.projectId === project.projectId) {
      await ddb.send(new DeleteCommand({ TableName: TABLE(), Key: { pk: PROFILE_PK, sk: prof.sk } }));
      deleted++;
    }
  }
  await ddb.send(new DeleteCommand({ TableName: TABLE(), Key: { pk: PROJECT_PK, sk: project.sk } }));
  return deleted + 1;
}

export const listProfiles = (): Promise<ProfileCacheItem[]> => queryAll<ProfileCacheItem>(PROFILE_PK);

export async function putProfile(item: ProfileCacheItem): Promise<void> {
  await ddb.send(new PutCommand({ TableName: TABLE(), Item: item }));
}

export const listIdentityHints = (): Promise<IdentityHintItem[]> => queryAll<IdentityHintItem>(IDENTITY_PK);

/** Build the parser's attribution maps. Negative-cached profiles are excluded on purpose so
 * requestMetadata / identity hints still apply to traffic through an untagged profile. */
export async function loadAttributionMaps(): Promise<AttributionMaps> {
  const [profiles, hints] = await Promise.all([listProfiles(), listIdentityHints()]);
  const profileMap = new Map<string, { projectId: string; underlyingModelId: string }>();
  for (const p of profiles) {
    if (p.projectId && p.projectId !== 'untagged') {
      profileMap.set(p.arn, { projectId: p.projectId, underlyingModelId: p.underlyingModelId });
    }
  }
  const identityMap = new Map<string, string>();
  for (const h of hints) identityMap.set(h.identityArn, h.projectId);
  return { profiles: profileMap, identities: identityMap };
}

export async function getSeedMarker(): Promise<{ seededAt: string; projects: string[] } | null> {
  const res = await ddb.send(new GetCommand({ TableName: TABLE(), Key: { pk: 'REGISTRY#META', sk: 'projects-seed' } }));
  return (res.Item as { seededAt: string; projects: string[] } | undefined) ?? null;
}

export async function putSeedMarker(projects: string[]): Promise<void> {
  await ddb.send(new PutCommand({
    TableName: TABLE(),
    Item: { pk: 'REGISTRY#META', sk: 'projects-seed', seededAt: new Date().toISOString(), projects },
  }));
}

/** Apply the config seed once (no-op afterwards, even if admins delete every project). */
export async function seedIfNeeded(): Promise<string[]> {
  const seeds = parseSeedJson(process.env.PROJECTS_SEED_JSON);
  if (!seeds.length) return [];
  const [marker, existing] = await Promise.all([getSeedMarker(), listProjects()]);
  if (!shouldSeed(!!marker, existing.length, seeds)) {
    if (!marker) await putSeedMarker(seeds.map((s) => s.id));
    return [];
  }
  const created: string[] = [];
  for (const s of seeds) {
    const { project, error } = validateProject(
      { id: s.id, name: s.name, costCenter: s.costCenter, repos: s.repos, identityArns: s.identityArns },
      'seed',
    );
    if (error || !project) { console.warn('project-registry: skipping invalid seed', s.id, error); continue; }
    project.seededBy = 'config';
    await putProject(project);
    created.push(project.projectId);
  }
  await putSeedMarker(seeds.map((s) => s.id));
  console.log('project-registry: seeded projects', created);
  return created;
}

// ---------- ROI org defaults (#14) ----------

export interface RoiDefaultsItem {
  pk: 'REGISTRY#META';
  sk: 'roi-defaults';
  defaults: ProjectRoiConfig;
  updatedBy: string;
  updatedAt: string;
}

export async function getRoiDefaults(): Promise<ProjectRoiConfig> {
  const res = await ddb.send(new GetCommand({ TableName: TABLE(), Key: { pk: 'REGISTRY#META', sk: 'roi-defaults' } }));
  return ((res.Item as RoiDefaultsItem | undefined)?.defaults) ?? {};
}

export async function putRoiDefaults(defaults: ProjectRoiConfig, updatedBy: string): Promise<void> {
  const item: RoiDefaultsItem = {
    pk: 'REGISTRY#META', sk: 'roi-defaults', defaults, updatedBy, updatedAt: new Date().toISOString(),
  };
  await ddb.send(new PutCommand({ TableName: TABLE(), Item: item }));
}
