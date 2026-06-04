/**
 * Pure cost-calculation logic (no AWS calls) so it can be unit-tested offline.
 *
 * Rates are per-token USD from the official Anthropic pricing page (per MTok ÷ 1e6); reconfirm
 * and keep current. `cacheReadPerToken` is the prompt-cache hit rate (0.1× base input).
 */
export interface ModelRate {
  key: string;
  inPerToken: number;
  outPerToken: number;
  cacheReadPerToken: number;
}

export const RATE_CARD: ModelRate[] = [
  { key: 'opus-4-8', inPerToken: 0.000005, outPerToken: 0.000025, cacheReadPerToken: 0.0000005 },
  { key: 'opus', inPerToken: 0.000005, outPerToken: 0.000025, cacheReadPerToken: 0.0000005 },
  { key: 'sonnet', inPerToken: 0.000003, outPerToken: 0.000015, cacheReadPerToken: 0.0000003 },
  { key: 'haiku', inPerToken: 0.000001, outPerToken: 0.000005, cacheReadPerToken: 0.0000001 },
];

const ZERO_RATE: ModelRate = { key: '', inPerToken: 0, outPerToken: 0, cacheReadPerToken: 0 };

/** First matching rate by modelId substring; zero rate if unknown (so cost shows 0, not wrong). */
export function matchRate(modelId: string, card: ModelRate[] = RATE_CARD): ModelRate {
  for (const r of card) if (modelId.includes(r.key)) return r;
  return ZERO_RATE;
}

export interface TokenCounts {
  modelId: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
}

export interface ModelCost {
  modelId: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  estimatedUsd: number;
  /** What the cache-read tokens WOULD have cost at full input price. */
  cacheSavingsUsd: number;
}

const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

/**
 * Cost for one model's token counts. Savings = cache-read tokens priced at full input rate
 * minus their actual 0.1× cache rate — i.e. the money prompt caching saved.
 */
export function computeModelCost(t: TokenCounts, card: ModelRate[] = RATE_CARD): ModelCost {
  const rate = matchRate(t.modelId, card);
  const inTok = t.inputTokens ?? 0;
  const outTok = t.outputTokens ?? 0;
  const cacheTok = t.cacheReadTokens ?? 0;

  const estimatedUsd = inTok * rate.inPerToken + outTok * rate.outPerToken + cacheTok * rate.cacheReadPerToken;
  // If those cache-read tokens had been charged as normal input tokens:
  const cacheAtFull = cacheTok * rate.inPerToken;
  const cacheAtActual = cacheTok * rate.cacheReadPerToken;
  const cacheSavingsUsd = cacheAtFull - cacheAtActual;

  return {
    modelId: t.modelId,
    inputTokens: inTok,
    outputTokens: outTok,
    cacheReadTokens: cacheTok,
    estimatedUsd: round6(estimatedUsd),
    cacheSavingsUsd: round6(cacheSavingsUsd),
  };
}

export interface CostSummary {
  byModel: ModelCost[];
  totalEstimatedUsd: number;
  totalCacheSavingsUsd: number;
}

/** Aggregate per-model costs + totals (including total prompt-cache savings). */
export function summarizeCosts(items: TokenCounts[], card: ModelRate[] = RATE_CARD): CostSummary {
  const byModel = items.map((i) => computeModelCost(i, card));
  return {
    byModel,
    totalEstimatedUsd: round6(byModel.reduce((s, m) => s + m.estimatedUsd, 0)),
    totalCacheSavingsUsd: round6(byModel.reduce((s, m) => s + m.cacheSavingsUsd, 0)),
  };
}
