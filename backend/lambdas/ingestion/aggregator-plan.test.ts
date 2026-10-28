import { planObjects, usersToAdd, USER_SET_CAP, LIST_OVERLAP_MS } from './aggregator';

describe('planObjects — what one aggregator run touches (feature-47 idempotency)', () => {
  const o = (key: string, lastModified: number) => ({ key, lastModified });
  it('drops split-out bodies, permission markers and already-processed keys, oldest first', () => {
    const listed = [
      o('p/2026/10/28/10/b.json.gz', 300),
      o('p/2026/10/28/10/a.json.gz', 200),
      o('p/2026/10/28/10/data/big-body', 250),
      o('p/permission-check', 100),
      o('p/2026/10/28/09/z.json.gz', 150),
    ];
    const plan = planObjects(listed, new Set(['p/2026/10/28/09/z.json.gz']));
    expect(plan.map((x) => x.key)).toEqual(['p/2026/10/28/10/a.json.gz', 'p/2026/10/28/10/b.json.gz']);
  });
  it('is deterministic for equal timestamps (key order) so two runs plan the same sequence', () => {
    const plan = planObjects([o('k2', 5), o('k1', 5)], new Set());
    expect(plan.map((x) => x.key)).toEqual(['k1', 'k2']);
  });
  it('a retry after a crash re-plans only the unprocessed tail', () => {
    const listed = [o('k1', 1), o('k2', 2), o('k3', 3)];
    expect(planObjects(listed, new Set(['k1', 'k2'])).map((x) => x.key)).toEqual(['k3']);
  });
  it('the listing overlap is one minute — same-second objects after a crash are re-listed, not lost', () => {
    expect(LIST_OVERLAP_MS).toBe(60_000);
  });
});

describe('usersToAdd — the PROJECT userSet stops growing at the cap', () => {
  it('adds everything while there is room', () => {
    expect(usersToAdd(['u1', 'u2', 'u1'], 10)).toEqual({ add: ['u1', 'u2'], overflow: false });
  });
  it('fills the remaining room and flags overflow', () => {
    expect(usersToAdd(['a', 'b', 'c'], USER_SET_CAP - 2)).toEqual({ add: ['a', 'b'], overflow: true });
  });
  it('adds nothing once full, but still flags when callers keep sending new ids', () => {
    expect(usersToAdd(['x'], USER_SET_CAP)).toEqual({ add: [], overflow: true });
    expect(usersToAdd([], USER_SET_CAP)).toEqual({ add: [], overflow: false });
  });
  it('a hostile caller with 10,000 distinct user_ids cannot push the item past the cap', () => {
    const ids = Array.from({ length: 10_000 }, (_, i) => `user-${i}`);
    const r = usersToAdd(ids, 0);
    expect(r.add.length).toBe(USER_SET_CAP); expect(r.overflow).toBe(true);
  });
});
