import { getIdToken } from '../auth/cognito';

const BASE = import.meta.env.VITE_API_URL as string;

/** Thin fetch wrapper that attaches the Cognito JWT and parses JSON. */
async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = await getIdToken();
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: token } : {}),
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) throw new Error(`API ${path} failed: ${res.status}`);
  return res.json() as Promise<T>;
}

export interface UsagePoint {
  timestamp: string;
  inputTokens: number;
  outputTokens: number;
  invocations: number;
  label?: string; // short HH:MM label for chart axis (set client-side)
}

export const api = {
  usage: (from?: string, to?: string) =>
    request<{ points: UsagePoint[] }>(
      `v1/usage${from || to ? `?from=${from ?? ''}&to=${to ?? ''}` : ''}`,
    ),
  costs: () => request<{ byModel: any[]; totalEstimatedUsd: number }>('v1/costs'),
  anomalies: () => request<{ anomalies: any[] }>('v1/anomalies'),
  projects: () => request<{ projects: any[] }>('v1/projects'),
  quotas: () => request<{ throttles: { throttledCount: number; clientErrors: number; throttled: boolean }; headroom: any[] }>('v1/quotas'),
  startQuery: (template: string, days: number) =>
    request<{ id: string }>('v1/queries', { method: 'POST', body: JSON.stringify({ template, days }) }),
  pollQuery: (id: string) => request<{ id: string; state: string; rows?: any[] }>(`v1/queries/${id}`),
};
