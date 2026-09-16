/**
 * Minimal GitHub REST client over Node 20's global fetch (no octokit dependency). Handles
 * pagination via the Link header and stops *before* exhausting the rate limit so a long backfill
 * degrades to "resume next run" instead of a burst of 403s. Pure helpers are unit-tested.
 */

export const GITHUB_API = 'https://api.github.com';
/** Stop paging when fewer than this many requests remain in the current window. */
export const RATE_LIMIT_FLOOR = 50;

export class RateLimitedError extends Error {
  constructor(public readonly resetAt: Date | null, public readonly remaining: number | null) {
    super(`GitHub rate limit reached${resetAt ? ` — resets at ${resetAt.toISOString()}` : ''}`);
    this.name = 'RateLimitedError';
  }
}

export class GithubHttpError extends Error {
  constructor(public readonly status: number, public readonly path: string, body: string) {
    super(`GitHub ${status} on ${path}: ${body.slice(0, 200)}`);
    this.name = 'GithubHttpError';
  }
}

export interface RateLimitInfo { remaining: number | null; resetAt: Date | null }

/** Parse X-RateLimit-* headers (case-insensitive lookup is handled by the Headers object). */
export function parseRateLimit(headers: { get(name: string): string | null }): RateLimitInfo {
  const rem = headers.get('x-ratelimit-remaining');
  const reset = headers.get('x-ratelimit-reset');
  const remaining = rem != null && rem !== '' && Number.isFinite(Number(rem)) ? Number(rem) : null;
  const resetAt = reset != null && Number.isFinite(Number(reset)) ? new Date(Number(reset) * 1000) : null;
  return { remaining, resetAt };
}

/** Extract the `rel="next"` URL from a Link header, or null on the last page. */
export function parseNextLink(link: string | null): string | null {
  if (!link) return null;
  for (const part of link.split(',')) {
    const m = part.match(/<([^>]+)>\s*;\s*rel="next"/);
    if (m) return m[1];
  }
  return null;
}

export interface GithubResponse<T> { data: T; rate: RateLimitInfo; nextUrl: string | null }

export interface GithubClient {
  /** GET a JSON resource; `path` may be relative ("/repos/o/n") or an absolute next-page URL. */
  getJson<T>(path: string): Promise<GithubResponse<T>>;
  /**
   * Iterate pages of a list endpoint until `stop(page)` returns true or pages run out.
   * Returns every item fetched (including those on the page that triggered `stop`).
   */
  paginate<T>(path: string, stop?: (page: T[]) => boolean, maxPages?: number): Promise<T[]>;
  /** Remaining requests as of the last response (null before the first call). */
  readonly remaining: number | null;
}

export function createGithubClient(token: string, fetchImpl: typeof fetch = fetch): GithubClient {
  let remaining: number | null = null;

  const getJson = async <T>(path: string): Promise<GithubResponse<T>> => {
    if (remaining != null && remaining < RATE_LIMIT_FLOOR) throw new RateLimitedError(null, remaining);
    const url = path.startsWith('http') ? path : `${GITHUB_API}${path}`;
    const res = await fetchImpl(url, {
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'tums-dora-collector',
      },
    });
    const rate = parseRateLimit(res.headers);
    if (rate.remaining != null) remaining = rate.remaining;
    if (res.status === 429 || (res.status === 403 && rate.remaining === 0)) {
      throw new RateLimitedError(rate.resetAt, rate.remaining);
    }
    if (!res.ok) throw new GithubHttpError(res.status, path, await res.text().catch(() => ''));
    return { data: (await res.json()) as T, rate, nextUrl: parseNextLink(res.headers.get('link')) };
  };

  const paginate = async <T>(path: string, stop?: (page: T[]) => boolean, maxPages = 20): Promise<T[]> => {
    const out: T[] = [];
    let next: string | null = path;
    for (let i = 0; next && i < maxPages; i++) {
      const page: GithubResponse<T[]> = await getJson<T[]>(next);
      out.push(...page.data);
      if (page.data.length === 0 || (stop && stop(page.data))) break;
      next = page.nextUrl;
    }
    return out;
  };

  return { getJson, paginate, get remaining() { return remaining; } };
}

// ---- Shapes we read from the GitHub API (only the fields used) ----

export interface GhPull {
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  created_at: string;
  updated_at: string;
  merged_at: string | null;
  html_url: string;
  user: { login: string } | null;
  head: { ref: string };
  base: { ref: string };
  labels: { name: string }[];
}

export interface GhCommit {
  sha: string;
  commit: { message: string; author: { date: string } | null; committer: { date: string } | null };
}

export interface GhIssue {
  number: number;
  title: string;
  created_at: string;
  closed_at: string | null;
  html_url: string;
  labels: { name: string }[];
  pull_request?: unknown;
}

export interface GhRepo {
  full_name: string;
  default_branch: string;
  owner: { login: string };
  name: string;
  private: boolean;
}
