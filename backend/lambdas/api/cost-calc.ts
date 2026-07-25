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
  // Mythos-class tier above Opus ($10/$50 per MTok; cache-read 0.1x input).
  { key: 'fable-5', inPerToken: 0.00001, outPerToken: 0.00005, cacheReadPerToken: 0.000001 },
  { key: 'mythos', inPerToken: 0.00001, outPerToken: 0.00005, cacheReadPerToken: 0.000001 },
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

/** The same model can be metered under a bare id and a full inference-profile ARN
 * (arn:...:inference-profile/<id>). Strip the ARN prefix so both merge into one row. */
export function normalizeModelId(id: string): string {
  return id.replace(/^arn:[^/]+\/(?=.)/, '');
}

/**
 * Aggregate per-model costs + totals (including total prompt-cache savings).
 * Duplicate rows for the same (normalized) model are merged, and rows with zero usage
 * across all token kinds are dropped — they'd only inflate the "Models used" KPI.
 */
export function summarizeCosts(items: TokenCounts[], card: ModelRate[] = RATE_CARD): CostSummary {
  const merged = new Map<string, TokenCounts>();
  for (const raw of items) {
    const id = normalizeModelId(raw.modelId);
    const acc = merged.get(id) ?? { modelId: id, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };
    acc.inputTokens = (acc.inputTokens ?? 0) + (raw.inputTokens ?? 0);
    acc.outputTokens = (acc.outputTokens ?? 0) + (raw.outputTokens ?? 0);
    acc.cacheReadTokens = (acc.cacheReadTokens ?? 0) + (raw.cacheReadTokens ?? 0);
    merged.set(id, acc);
  }
  const byModel = Array.from(merged.values())
    .filter((i) => (i.inputTokens ?? 0) + (i.outputTokens ?? 0) + (i.cacheReadTokens ?? 0) > 0)
    .map((i) => computeModelCost(i, card));
  return {
    byModel,
    totalEstimatedUsd: round6(byModel.reduce((s, m) => s + m.estimatedUsd, 0)),
    totalCacheSavingsUsd: round6(byModel.reduce((s, m) => s + m.cacheSavingsUsd, 0)),
  };
}
