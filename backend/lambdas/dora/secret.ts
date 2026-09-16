import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';

/** Placeholder written by CDK when the secret is created; the operator replaces it with a PAT. */
export const TOKEN_PLACEHOLDER = 'REPLACE_ME';

const sm = new SecretsManagerClient({});
let cached: { value: string | null; at: number } | null = null;
const TTL_MS = 5 * 60_000;

/**
 * Load the GitHub token from Secrets Manager (`GITHUB_TOKEN_SECRET_NAME`). Returns null when the
 * secret is missing, empty or still the placeholder, so callers can show a friendly
 * "token not configured" state instead of failing with 401s from GitHub. Cached for 5 minutes
 * per Lambda container. Accepts either a plain string or a JSON object with a `token` key.
 */
export async function loadGithubToken(): Promise<string | null> {
  if (cached && Date.now() - cached.at < TTL_MS) return cached.value;
  const name = process.env.GITHUB_TOKEN_SECRET_NAME;
  let value: string | null = null;
  if (name) {
    try {
      const res = await sm.send(new GetSecretValueCommand({ SecretId: name }));
      value = normalizeToken(res.SecretString ?? null);
    } catch (err) {
      console.warn('dora: could not read GitHub token secret', name, (err as Error).message);
      value = null;
    }
  }
  cached = { value, at: Date.now() };
  return value;
}

export function normalizeToken(raw: string | null): string | null {
  if (!raw) return null;
  let s = raw.trim();
  if (s.startsWith('{')) {
    try {
      const obj = JSON.parse(s) as Record<string, unknown>;
      s = String(obj.token ?? obj.GITHUB_TOKEN ?? obj.pat ?? '').trim();
    } catch { /* fall through with the raw string */ }
  }
  if (!s || s === TOKEN_PLACEHOLDER) return null;
  return s;
}

/** Test hook. */
export function _resetTokenCache(): void { cached = null; }
