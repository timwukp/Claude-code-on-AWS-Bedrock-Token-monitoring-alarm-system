/**
 * Project registry API (#13) — the admin-managed mapping that joins everything:
 * project ↔ GitHub repos (DORA) ↔ identity hints (log attribution) ↔ cost center.
 *
 *   GET    /v1/projects/registry            list projects + resolved AIP profiles (+ isAdmin)
 *   GET    /v1/projects/registry/defaults   org-wide ROI assumption defaults (#14)
 *   PUT    /v1/projects/registry/defaults   [admin] update the org defaults
 *   POST   /v1/projects/registry        [admin] upsert {id,name,costCenter?,repos?,identityArns?}
 *   DELETE /v1/projects/registry/{id}   [admin] cascade (project + identity hints + profile cache)
 *
 * Seeds the registry from config (PROJECTS_SEED_JSON) on first GET — the same seed-once
 * pattern the DORA collector uses.
 */
import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { badRequest, created, forbidden, notFound, ok, serverError } from '../shared/response';
import { getTenantId } from '../shared/tenant';
import { isAdmin } from '../shared/admin';
import * as registry from '../shared/project-registry';

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    getTenantId(event); // auth parity with every other route
    const route = `${event.httpMethod} ${event.resource}`;
    switch (route) {
      case 'GET /v1/projects/registry': return list(event);
      case 'GET /v1/projects/registry/defaults': return getDefaults(event);
      case 'PUT /v1/projects/registry/defaults': return putDefaults(event);
      case 'POST /v1/projects/registry': return upsert(event);
      case 'DELETE /v1/projects/registry/{id}': return remove(event);
      default: return notFound(`Unknown route ${route}`);
    }
  } catch (err) {
    console.error(err);
    return serverError();
  }
};

async function list(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  await registry.seedIfNeeded();
  const admin = isAdmin(event);
  const [projects, profiles] = await Promise.all([registry.listProjects(), registry.listProfiles()]);
  // The registry is account-wide (single-organisation deployment). Identity ARNs, profile ARNs (which carry the
  // account id) and the e-mail of whoever added a project are administration detail: every signed-in user needs
  // the names and ids for attribution, only admins need the rest (feature-49, audit #9).
  return ok({
    projects: projects.map((p) => toProjectView(p, admin)),
    profiles: profiles.map((p) => ({
      ...(admin ? { arn: p.arn } : {}),
      projectId: p.projectId,
      underlyingModelId: p.underlyingModelId,
      profileName: p.profileName ?? (admin ? null : p.arn.split('/').pop() ?? null),
      resolvedAt: p.resolvedAt,
    })),
    isAdmin: admin,
  });
}

async function getDefaults(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  return ok({ defaults: await registry.getRoiDefaults(), isAdmin: isAdmin(event) });
}

async function putDefaults(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  if (!isAdmin(event)) return forbidden('Only members of the admin group can set ROI defaults.');
  let body: unknown = {};
  try { body = JSON.parse(event.body ?? '{}'); } catch { return badRequest('Body must be JSON'); }
  const { roi, error } = registry.validateRoiConfig((body as { defaults?: unknown }).defaults ?? body);
  if (error) return badRequest(error);
  const email = String(event.requestContext.authorizer?.claims?.email ?? 'admin');
  await registry.putRoiDefaults(roi ?? {}, email);
  return ok({ defaults: roi ?? {} });
}

async function upsert(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  if (!isAdmin(event)) return forbidden('Only members of the admin group can manage projects.');
  let body: registry.ProjectInput = {};
  try { body = JSON.parse(event.body ?? '{}'); } catch { return badRequest('Body must be JSON'); }
  const email = String(event.requestContext.authorizer?.claims?.email ?? 'admin');
  const { project, error } = registry.validateProject(body, email);
  if (error || !project) return badRequest(error ?? 'invalid project');
  const existing = await registry.getProject(project.projectId);
  if (existing?.seededBy) project.seededBy = existing.seededBy; // keep provenance on upsert
  await registry.putProject(project);
  return created({ project: toProjectView(project) });
}

async function remove(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  if (!isAdmin(event)) return forbidden('Only members of the admin group can manage projects.');
  const id = decodeURIComponent(event.pathParameters?.id ?? '').toLowerCase();
  if (!registry.PROJECT_ID_RE.test(id)) return badRequest('Invalid project id');
  const items = await registry.deleteProjectCascade(id);
  if (items === 0) return notFound(`${id} is not registered`);
  return ok({ deleted: true, projectId: id, items });
}

export function toProjectView(p: registry.RegistryProject, admin = true) {
  return {
    projectId: p.projectId,
    name: p.name,
    costCenter: p.costCenter ?? null,
    repos: p.repos,
    identityArns: admin ? p.identityArns : [],
    identityArnCount: p.identityArns.length,
    addedBy: admin ? p.addedBy : null,
    addedAt: p.addedAt,
    seeded: p.seededBy === 'config',
    roi: p.roi ?? null,
  };
}
