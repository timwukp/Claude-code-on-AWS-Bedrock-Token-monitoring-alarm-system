import { toIssueItem, toPrItem } from './collector';
import { GhCommit, GhIssue, GhPull } from './github-client';

const pull = (o: Partial<GhPull> = {}): GhPull => ({
  number: 42,
  title: 'feat: add DORA page',
  body: '🤖 Generated with [Claude Code](https://claude.com/claude-code)',
  state: 'closed',
  created_at: '2026-09-10T08:00:00Z',
  updated_at: '2026-09-11T10:00:00Z',
  merged_at: '2026-09-11T09:30:00Z',
  html_url: 'https://github.com/o/n/pull/42',
  user: { login: 'timwukp' },
  head: { ref: 'feat/dora' },
  base: { ref: 'main' },
  labels: [],
  ...o,
});
const commit = (date: string, message = 'feat: x'): GhCommit => ({ sha: date, commit: { message, author: { date }, committer: { date } } });

describe('toPrItem', () => {
  it('derives keys, first commit, classification and AI attribution', () => {
    const item = toPrItem('o/N', pull(), [commit('2026-09-10T07:00:00Z'), commit('2026-09-09T20:00:00Z', 'x\n\nCo-Authored-By: Claude <noreply@anthropic.com>')]);
    expect(item.pk).toBe('PR#o/n');
    expect(item.sk).toBe('2026-09-11T09:30:00Z#000042');
    expect(item.firstCommitAt).toBe('2026-09-09T20:00:00Z');
    expect(item.commitCount).toBe(2);
    expect(item.assistedBy).toBe('claude-code');
    expect(item.aiSignals).toEqual(['trailer:claude', 'body:claude-code']);
    expect(item.isRevert).toBe(false);
    expect(item.isHotfix).toBe(false);
  });
  it('falls back to created_at when no commits are returned and flags hotfix branches', () => {
    const item = toPrItem('o/n', pull({ head: { ref: 'hotfix/login' }, body: null, user: null }), []);
    expect(item.firstCommitAt).toBe('2026-09-10T08:00:00Z');
    expect(item.author).toBe('unknown');
    expect(item.isHotfix).toBe(true);
    expect(item.assistedBy).toBeNull();
  });
});

describe('toIssueItem', () => {
  it('maps an incident issue', () => {
    const issue: GhIssue = { number: 7, title: 'Login broken', created_at: '2026-09-01T00:00:00Z', closed_at: null, html_url: 'u', labels: [{ name: 'bug' }] };
    expect(toIssueItem('O/N', issue)).toMatchObject({ pk: 'ISSUE#o/n', sk: '2026-09-01T00:00:00Z#000007', labels: ['bug'], closedAt: null });
  });
});
