/**
 * Pure logic for Bedrock token-quota headroom + throttle summarisation (no AWS calls), so it is
 * unit-testable offline. Bedrock enforces per-model tokens-per-minute (TPM) and max-tokens-per-day
 * quotas; breaching them returns HTTP 429. See docs/GOVERNANCE_FAQ.md §2 and docs/ROADMAP.md #2.
 */

export interface QuotaInfo {
  /** Human-readable quota name from Service Quotas. */
  name: string;
  /** Quota limit value (tokens). */
  limit: number;
  /** "minute" | "day" — the window the quota applies to. */
  window: 'minute' | 'day';
  /** Whether AWS allows raising it on request. */
  adjustable: boolean;
}

export interface QuotaHeadroom extends QuotaInfo {
  /** Observed token usage in the comparable window (tokens). */
  used: number;
  /** Remaining tokens before the limit. */
  remaining: number;
  /** Percent of the limit consumed (0–100, capped). */
  usedPct: number;
  /** Coarse status for dashboard coloring. */
  status: 'ok' | 'warn' | 'critical';
}

const clampPct = (n: number) => Math.max(0, Math.min(100, Math.round(n * 10) / 10));

/** Compute headroom for one quota given observed usage in the same window. */
export function computeHeadroom(q: QuotaInfo, used: number): QuotaHeadroom {
  const safeLimit = q.limit > 0 ? q.limit : 0;
  const remaining = Math.max(0, safeLimit - used);
  const usedPct = safeLimit > 0 ? clampPct((used / safeLimit) * 100) : 0;
  const status: QuotaHeadroom['status'] = usedPct >= 90 ? 'critical' : usedPct >= 70 ? 'warn' : 'ok';
  return { ...q, used, remaining, usedPct, status };
}

export interface ThrottleSummary {
  /** Sum of InvocationThrottles over the window (0 if the metric has no datapoints). */
  throttledCount: number;
  /** Sum of client errors (4xx incl. throttling) over the window. */
  clientErrors: number;
  /** True if any throttling was observed — a signal to raise quotas. */
  throttled: boolean;
}

/** Summarise raw metric sums into a throttle status. Missing datapoints are treated as 0. */
export function summarizeThrottles(throttledCount?: number, clientErrors?: number): ThrottleSummary {
  const t = throttledCount ?? 0;
  const c = clientErrors ?? 0;
  return { throttledCount: t, clientErrors: c, throttled: t > 0 };
}

/**
 * Classify a Service Quotas quota name into its window; null if it isn't a token quota we track.
 * Excludes the `bedrock-mantle` endpoint quotas (our calls go through `bedrock-runtime`, whose
 * CloudWatch metrics we measure) and latency-optimized variants, so the panel compares like with
 * like.
 */
export function windowOf(quotaName: string): 'minute' | 'day' | null {
  const n = quotaName.toLowerCase();
  if (n.includes('bedrock-mantle') || n.includes('latency-optimized')) return null;
  if (n.includes('per minute')) return 'minute';
  if (n.includes('per day')) return 'day';
  return null;
}

/**
 * Derive matchable keywords from a CloudWatch ModelId so it can be linked to a Service Quotas
 * quota name. e.g. "us.anthropic.claude-opus-4-8" -> ["claude","opus","4","8"];
 * "us.anthropic.claude-haiku-4-5-20251001-v1:0" -> ["claude","haiku","4","5"].
 * Region prefixes (us./global./eu.), provider, version suffixes and dates are dropped.
 */
export function modelKeywords(modelId: string): string[] {
  const tail = modelId.split('.').pop() ?? modelId; // strip us./global./anthropic. prefixes
  return tail
    .toLowerCase()
    .replace(/[:].*$/, '')           // drop ":0" etc.
    .replace(/-v\d+.*$/, '')          // drop "-v1..."
    .replace(/-\d{6,}.*$/, '')        // drop date stamps like -20251001
    .split('-')
    .filter((t) => t && t !== 'anthropic');
}

/**
 * Match a model to its quota for a given window: pick the token quota (of that window) whose name
 * contains all of the model's keywords. Prefers the most specific (longest) name match; returns
 * null if none matches (the handler then skips that model/window rather than mis-attributing).
 */
export function matchQuotaForModel(
  quotas: QuotaInfo[], modelId: string, window: 'minute' | 'day',
): QuotaInfo | null {
  const kws = modelKeywords(modelId);
  if (!kws.length) return null;
  const candidates = quotas
    .filter((q) => q.window === window)
    .filter((q) => {
      const n = q.name.toLowerCase();
      return kws.every((k) => n.includes(k));
    })
    // Prefer on-demand/standard over cross-region/global variants, then the shortest (most direct) name.
    .sort((a, b) => a.name.length - b.name.length);
  return candidates[0] ?? null;
}
