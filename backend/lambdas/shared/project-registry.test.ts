import { parseSeedJson, shouldSeed, validateProject } from './project-registry';

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
