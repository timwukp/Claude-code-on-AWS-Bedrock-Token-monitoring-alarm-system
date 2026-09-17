import { detectAssistedBy, isHotfixPr, isIncidentIssue, isRevertPr } from './dora-classify';

describe('isRevertPr', () => {
  it('matches "Revert ..." titles case-insensitively', () => {
    expect(isRevertPr('Revert "feat: add thing"')).toBe(true);
    expect(isRevertPr('revert: undo PR #33 ABAC CDK changes (wrong repo)')).toBe(true);
  });
  it('matches the revert label regardless of title', () => {
    expect(isRevertPr('fix: something', ['Revert'])).toBe(true);
  });
  it('does not match reverts mentioned mid-title', () => {
    expect(isRevertPr('feat: add revert button')).toBe(false);
    expect(isRevertPr(null)).toBe(false);
  });
});

describe('isHotfixPr', () => {
  it('matches hotfix titles and [hotfix] prefixes', () => {
    expect(isHotfixPr('hotfix: null deref', 'main')).toBe(true);
    expect(isHotfixPr('[HOTFIX] restore login', 'feature/x')).toBe(true);
    expect(isHotfixPr('Hotfix for prod', 'x')).toBe(true);
  });
  it('matches hotfix/ and patch- branches but not "patched"', () => {
    expect(isHotfixPr('fix', 'hotfix/login')).toBe(true);
    expect(isHotfixPr('fix', 'patch-1')).toBe(true);
    expect(isHotfixPr('fix', 'patch')).toBe(true);
    expect(isHotfixPr('fix', 'patched-feature')).toBe(false);
    expect(isHotfixPr('fix', 'feature/hotfix-tooling')).toBe(false);
  });
  it('matches hotfix / incident labels', () => {
    expect(isHotfixPr('fix', 'x', ['incident'])).toBe(true);
    expect(isHotfixPr('fix', 'x', ['Hotfix'])).toBe(true);
    expect(isHotfixPr('fix: typo', 'fix/typo', ['bug'])).toBe(false);
  });
});

describe('isIncidentIssue', () => {
  it('accepts bug/incident-labelled issues and rejects PR-shaped items', () => {
    expect(isIncidentIssue({ labels: ['bug', 'documentation'] })).toBe(true);
    expect(isIncidentIssue({ labels: ['Incident'] })).toBe(true);
    expect(isIncidentIssue({ labels: ['enhancement'] })).toBe(false);
    expect(isIncidentIssue({ labels: ['bug'], pull_request: { url: 'x' } })).toBe(false);
    expect(isIncidentIssue({})).toBe(false);
  });
});

describe('detectAssistedBy', () => {
  it('detects Claude via a real Co-Authored-By trailer', () => {
    const r = detectAssistedBy({
      author: 'timwukp',
      commitMessages: ['feat: x\n\nCo-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>'],
    });
    expect(r.assistedBy).toBe('claude-code');
    expect(r.signals).toContain('trailer:claude');
  });
  it('detects Claude Code from the PR body marker', () => {
    const r = detectAssistedBy({ author: 'timwukp', body: '🤖 Generated with [Claude Code](https://claude.com/claude-code)' });
    expect(r.assistedBy).toBe('claude-code');
    expect(r.signals).toEqual(['body:claude-code']);
  });
  it('detects Kiro and Amazon Q from body markers with word boundaries', () => {
    expect(detectAssistedBy({ body: 'Built with Kiro IDE specs' }).assistedBy).toBe('kiro');
    expect(detectAssistedBy({ body: 'Migrated by Amazon Q Developer' }).assistedBy).toBe('amazon-q');
    expect(detectAssistedBy({ body: 'see amazon-q docs' }).assistedBy).toBe('amazon-q');
    expect(detectAssistedBy({ body: 'the shakiro release' }).assistedBy).toBeNull();
  });
  it('detects bot authors', () => {
    expect(detectAssistedBy({ author: 'amazon-q-developer[bot]' }).assistedBy).toBe('amazon-q');
    expect(detectAssistedBy({ author: 'copilot-swe-agent[bot]' }).assistedBy).toBe('copilot');
    expect(detectAssistedBy({ author: 'dependabot[bot]' }).assistedBy).toBeNull();
  });
  it('prefers trailer evidence over body mentions when they disagree', () => {
    const r = detectAssistedBy({
      body: 'Replaces the Kiro workflow',
      commitMessages: ['x\n\nCo-Authored-By: Claude <noreply@anthropic.com>'],
    });
    expect(r.assistedBy).toBe('claude-code');
    expect(r.signals).toEqual(['trailer:claude', 'body:kiro']);
  });
  it('returns null for a plain human PR', () => {
    const r = detectAssistedBy({
      author: 'timwukp',
      body: 'Fixes #12',
      commitMessages: ['fix: x\n\nCo-authored-by: Tim WU <8848995+timwukp@users.noreply.github.com>'],
    });
    expect(r).toEqual({ assistedBy: null, signals: [] });
  });
});
