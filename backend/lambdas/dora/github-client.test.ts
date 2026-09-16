import { RATE_LIMIT_FLOOR, RateLimitedError, createGithubClient, parseNextLink, parseRateLimit } from './github-client';

const headers = (h: Record<string, string>) => new Headers(h);

describe('parseRateLimit', () => {
  it('reads remaining and reset epoch seconds', () => {
    const r = parseRateLimit(headers({ 'X-RateLimit-Remaining': '4999', 'X-RateLimit-Reset': '1789000000' }));
    expect(r.remaining).toBe(4999);
    expect(r.resetAt?.toISOString()).toBe(new Date(1789000000 * 1000).toISOString());
  });
  it('tolerates missing headers', () => {
    expect(parseRateLimit(headers({}))).toEqual({ remaining: null, resetAt: null });
  });
});

describe('parseNextLink', () => {
  it('returns the rel="next" URL and null on the last page', () => {
    const link = '<https://api.github.com/repositories/1/pulls?page=2>; rel="next", <https://api.github.com/repositories/1/pulls?page=9>; rel="last"';
    expect(parseNextLink(link)).toBe('https://api.github.com/repositories/1/pulls?page=2');
    expect(parseNextLink('<https://api.github.com/x?page=1>; rel="prev", <https://api.github.com/x?page=1>; rel="first"')).toBeNull();
    expect(parseNextLink(null)).toBeNull();
  });
});

describe('createGithubClient', () => {
  const mkFetch = (pages: Array<{ status?: number; body: unknown; headers?: Record<string, string> }>) => {
    const calls: string[] = [];
    let i = 0;
    const f = jest.fn(async (url: string) => {
      calls.push(url);
      const p = pages[Math.min(i++, pages.length - 1)];
      return new Response(JSON.stringify(p.body), { status: p.status ?? 200, headers: p.headers ?? {} });
    }) as unknown as typeof fetch;
    return { f, calls };
  };

  it('sends auth headers and follows Link pagination until stop() fires', async () => {
    const { f, calls } = mkFetch([
      { body: [{ n: 1 }, { n: 2 }], headers: { link: '<https://api.github.com/p?page=2>; rel="next"', 'x-ratelimit-remaining': '100' } },
      { body: [{ n: 3 }], headers: { link: '<https://api.github.com/p?page=3>; rel="next"' } },
      { body: [{ n: 4 }] },
    ]);
    const c = createGithubClient('tok', f);
    const items = await c.paginate<{ n: number }>('/p', (page) => page.some((x) => x.n === 3));
    expect(items.map((x) => x.n)).toEqual([1, 2, 3]);
    expect(calls).toEqual(['https://api.github.com/p', 'https://api.github.com/p?page=2']);
    const init = (f as jest.Mock).mock.calls[0][1];
    expect(init.headers.authorization).toBe('Bearer tok');
    expect(c.remaining).toBe(100);
  });

  it('throws RateLimitedError on 429 / 403-with-zero-remaining and when below the floor', async () => {
    const { f } = mkFetch([{ status: 403, body: { message: 'rate limited' }, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1789000000' } }]);
    await expect(createGithubClient('t', f).getJson('/x')).rejects.toBeInstanceOf(RateLimitedError);

    const low = mkFetch([{ body: {}, headers: { 'x-ratelimit-remaining': String(RATE_LIMIT_FLOOR - 1) } }]);
    const c = createGithubClient('t', low.f);
    await c.getJson('/first'); // succeeds but records low remaining
    await expect(c.getJson('/second')).rejects.toBeInstanceOf(RateLimitedError);
    expect(low.calls).toHaveLength(1);
  });

  it('surfaces other HTTP errors with status and path', async () => {
    const { f } = mkFetch([{ status: 404, body: { message: 'Not Found' } }]);
    await expect(createGithubClient('t', f).getJson('/repos/x/y')).rejects.toMatchObject({ status: 404, path: '/repos/x/y' });
  });
});
