import { parseSeedJson, shouldSeed, validateProject, validateRoiConfig } from './project-registry';

describe('validateProject', () => {
  it('normalizes id/repos/identityArns to lowercase and de-dups', () => {
    const { project, error } = validateProject(
      {
        id: 'Token-Monitoring',
        name: ' Token Usage Monitoring ',
        costCenter: 'CC-1',
        repos: ['TimWukp/Repo-One', 'timwukp/repo-one', 'o/b'],
        identityArns: ['arn:aws:iam::1:user/Alice', 'ARN:AWS:IAM::1:USER/ALICE'],
      },
      'admin@example.com',
    );
    expect(error).toBeUndefined();
    expect(project).toMatchObject({
      projectId: 'token-monitoring',
      sk: 'token-monitoring',
      name: 'Token Usage Monitoring',
      repos: ['timwukp/repo-one', 'o/b'],
      identityArns: ['arn:aws:iam::1:user/alice'],
      addedBy: 'admin@example.com',
    });
  });
  it('rejects bad slugs, missing names and malformed repos', () => {
    expect(validateProject({ id: 'Has Space', name: 'x' }, 't').error).toMatch(/id must match/);
    expect(validateProject({ id: '-leading', name: 'x' }, 't').error).toMatch(/id must match/);
    expect(validateProject({ id: 'ok', name: '' }, 't').error).toBe('name is required');
    expect(validateProject({ id: 'ok', name: 'x', repos: ['not a repo'] }, 't').error).toMatch(/owner\/name/);
  });
});

describe('shouldSeed', () => {
  const seeds = [{ id: 'a', name: 'A' }];
  it('seeds only once and only into an empty registry', () => {
    expect(shouldSeed(false, 0, seeds)).toBe(true);
    expect(shouldSeed(true, 0, seeds)).toBe(false); // marker exists
    expect(shouldSeed(false, 2, seeds)).toBe(false); // admin already added projects
    expect(shouldSeed(false, 0, [])).toBe(false);
  });
});

describe('parseSeedJson', () => {
  it('parses valid arrays and rejects garbage defensively', () => {
    expect(parseSeedJson(JSON.stringify([{ id: 'a', name: 'A' }, { id: '', name: 'drop' }]))).toEqual([{ id: 'a', name: 'A' }]);
    expect(parseSeedJson(undefined)).toEqual([]);
    expect(parseSeedJson('not json')).toEqual([]);
    expect(parseSeedJson('{"id":"obj"}')).toEqual([]);
  });
});

describe('validateRoiConfig (#14)', () => {
  it('accepts a full valid config and coerces numerics', () => {
    const { roi, error } = validateRoiConfig({
      teamSize: '4', loadedCostPerYear: 208000, netTimeSavedPct: -25,
      revenueImpactPerFeature: 0.005, category: 'product',
      jCurve: { include: true, dropPct: 15, months: 3 },
      baseline: { deploymentsPerYear: 60, cfrPct: 5, mttrHours: 2 },
    });
    expect(error).toBeUndefined();
    expect(roi).toMatchObject({ teamSize: 4, netTimeSavedPct: -25, category: 'product' });
    expect(roi!.jCurve).toEqual({ include: true, dropPct: 15, months: 3 });
  });
  it('rejects out-of-range and malformed fields with named errors', () => {
    expect(validateRoiConfig({ teamSize: 0 }).error).toMatch(/teamSize/);
    expect(validateRoiConfig({ teamSize: 2.5 }).error).toMatch(/integer/);
    expect(validateRoiConfig({ netTimeSavedPct: -150 }).error).toMatch(/netTimeSavedPct/);
    expect(validateRoiConfig({ revenueImpactPerFeature: 0.5 }).error).toMatch(/revenueImpactPerFeature/);
    expect(validateRoiConfig({ category: 'misc' }).error).toMatch(/category/);
    expect(validateRoiConfig({ baseline: { deploymentsPerYear: -1 } }).error).toMatch(/baseline/);
    expect(validateRoiConfig('nope').error).toMatch(/object/);
  });
  it('flows through validateProject and stays absent when empty', () => {
    const ok = validateProject({ id: 'p1', name: 'P', roi: { teamSize: 3 } }, 't');
    expect(ok.project!.roi).toEqual({ teamSize: 3 });
    const bad = validateProject({ id: 'p1', name: 'P', roi: { teamSize: -1 } }, 't');
    expect(bad.error).toMatch(/teamSize/);
    const none = validateProject({ id: 'p1', name: 'P' }, 't');
    expect(none.project!.roi).toBeUndefined();
  });
});
