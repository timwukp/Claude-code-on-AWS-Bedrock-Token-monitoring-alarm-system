/**
 * silver.project_registry: hourly snapshot of the TUMS project registry so attribution can be
 * recomputed in SQL (silver MERGE). Pure `buildRegistryRows` folds the three registry partitions into
 * one row per project; the handler marks the previous snapshot `is_current = false` and inserts the new one.
 */
import { AthenaClient } from '@aws-sdk/client-athena';
import { IdentityHintItem, listIdentityHints, listProfiles, listProjects, ProfileCacheItem, RegistryProject } from '../shared/project-registry';
import { SilverProjectRegistryRow } from './generated/row-types';
import { AthenaRunner, insertStatements, silverTableRef, sqlBool, sqlString, sqlTimestamp } from './athena-writer';

type ProjectLike = Pick<RegistryProject, 'projectId' | 'name'> & Partial<Pick<RegistryProject, 'costCenter' | 'repos' | 'identityArns'>>;
type ProfileLike = Pick<ProfileCacheItem, 'arn' | 'projectId'>;
type IdentityLike = Pick<IdentityHintItem, 'identityArn' | 'projectId'>;

export function buildRegistryRows(projects: ProjectLike[], profiles: ProfileLike[], identities: IdentityLike[], snapshotTs: string): SilverProjectRegistryRow[] {
  const byProject = new Map<string, { profiles: Set<string>; identities: Set<string> }>();
  const bucket = (id: string) => { let b = byProject.get(id); if (!b) { b = { profiles: new Set(), identities: new Set() }; byProject.set(id, b); } return b; };
  for (const p of profiles) if (p.projectId && p.projectId !== 'untagged') bucket(p.projectId).profiles.add(p.arn);
  for (const i of identities) if (i.projectId) bucket(i.projectId).identities.add(i.identityArn.toLowerCase());
  return projects
    .slice().sort((a, b) => a.projectId.localeCompare(b.projectId))
    .map((p) => {
      const b = bucket(p.projectId);
      for (const arn of p.identityArns ?? []) b.identities.add(arn.toLowerCase());
      return {
        snapshot_ts: snapshotTs, project_id: p.projectId, name: p.name ?? p.projectId, cost_center: p.costCenter ?? null,
        repos: JSON.stringify((p.repos ?? []).map((r) => r.toLowerCase()).sort()),
        identity_arns: JSON.stringify([...b.identities].sort()), profile_arns: JSON.stringify([...b.profiles].sort()), is_current: true,
      };
    });
}

export function registryStatements(tableBucket: string, rows: SilverProjectRegistryRow[]): string[] {
  const ref = silverTableRef(tableBucket, 'project_registry');
  const cols = ['snapshot_ts', 'project_id', 'name', 'cost_center', 'repos', 'identity_arns', 'profile_arns', 'is_current'];
  const values = rows.map((r) => [sqlTimestamp(r.snapshot_ts), ...[r.project_id, r.name, r.cost_center, r.repos, r.identity_arns, r.profile_arns].map(sqlString), sqlBool(r.is_current)]);
  return [`UPDATE ${ref} SET is_current = false WHERE is_current = true`, ...insertStatements(ref, cols, values)];
}

export const handler = async (): Promise<{ rows: number }> => {
  const [projects, profiles, identities] = await Promise.all([listProjects(), listProfiles(), listIdentityHints()]);
  const rows = buildRegistryRows(projects, profiles, identities, new Date().toISOString());
  const runner = new AthenaRunner(new AthenaClient({}), process.env.ATHENA_WORKGROUP!, process.env.ATHENA_OUTPUT);
  for (const sql of registryStatements(process.env.TABLE_BUCKET!, rows)) await runner.run(sql);
  console.log(JSON.stringify({ project_registry_rows: rows.length }));
  return { rows: rows.length };
};
