/**
 * Pure cost-calculation logic (no AWS calls) so it can be unit-tested offline.
 *
 * A Bedrock bill has FOUR token lines per model, and the card must price all four:
 *   input · output · cache read (0.1× input) · cache write (1.25× input for a 5-minute TTL,
 *   2× input for a 1-hour TTL — the two `cacheWrite*PerToken` rates below).
 * Until feature-36 the card priced no cache writes at all; on this account's Jun–Oct bill that line
 * was the LARGEST of the four (36.9%), so every total shown was roughly half the invoice.
 *
 * Rates are per-token USD (per MTok ÷ 1e6) from the AWS Price List (AmazonBedrockFoundationModels,
 * us-east-1, Global standard), read 2026-10-05; the cache-write multipliers were checked against the
 * per-model `cache-write-tokens` lines there and against Cost Explorer (within 0.3% on each of the
 * three largest models, Jun–Oct 2026). Reconfirm and keep current.
 *
 * KNOWN LOWER BOUND, still open: one rate per model family at the `global.` route price. Calls on
 * `us.`/geo routes and through application inference profiles are billed at the *standard* price,
 * ×1.1 — about 9% of this account's spend. That correction is a separate chain; until it lands every
 * figure this module produces is a disclosed lower bound, and the pages say so.
 */
export interface ModelRate {
  key: string;
  inPerToken: number;
  outPerToken: number;
  cacheReadPerToken: number;
  /** Prompt-cache write, 5-minute TTL (the default): 1.25× input. */
  cacheWrite5mPerToken: number;
  /** Prompt-cache write, 1-hour TTL: 2× input. */
  cacheWrite1hPerToken: number;
}

/** Published cache-write premiums over the input rate (Anthropic pricing, mirrored by the Price List). */
export const CACHE_WRITE_5M_MULT = 1.25;
export const CACHE_WRITE_1H_MULT = 2;

/** Per-token rates are exact to the picodollar; this keeps 4e-6 × 1.25 from rendering as 4.9999…e-6 in Athena SQL. */
const round12 = (n: number) => Math.round(n * 1e12) / 1e12;

/** One card row; cache-write rates default to the published multiples of the input rate. */
function rate(
  key: string, inPerToken: number, outPerToken: number, cacheReadPerToken: number,
  cacheWrite: { m5: number; h1: number } = { m5: inPerToken * CACHE_WRITE_5M_MULT, h1: inPerToken * CACHE_WRITE_1H_MULT },
): ModelRate {
  return {
    key, inPerToken, outPerToken, cacheReadPerToken,
    cacheWrite5mPerToken: round12(cacheWrite.m5), cacheWrite1hPerToken: round12(cacheWrite.h1),
  };
}

export const RATE_CARD: ModelRate[] = [
  // Bedrock on-demand global-CRI pricing (aws.amazon.com/bedrock/pricing, us-east-1).
  // One rate per model family: us./geo cross-region runs ~10% higher, but the guard tests
  // pin family rates and a single card keeps estimates simple; treat as lower-bound estimate.
  // matchRate takes the FIRST substring hit, so a point release must sit above its family row:
  // 'fable-5' also matches 'fable-5-1', 'opus' matches 'opus-5-5', 'sonnet' matches 'sonnet-5-5'.
  // Point-release rows below: AWS Price List (AmazonBedrockFoundationModels, us-east-1, Global
  // standard), read 2026-09-30; cache-write columns re-read 2026-10-05 (e.g. fable-5-1 $12.50 / $20
  // per MTok = 1.25× / 2× its $10 input).
  rate('fable-5-1', 0.00001, 0.00005, 0.00000025),
  rate('fable-5', 0.00001, 0.00005, 0.000001),
  rate('mythos-5-1', 0.00001, 0.00005, 0.00000025),
  rate('mythos', 0.00001, 0.00005, 0.000001),
  rate('opus-5-5', 0.000004, 0.00002, 0.0000002),
  rate('opus-4-8', 0.000005, 0.000025, 0.0000005),
  rate('opus', 0.000005, 0.000025, 0.0000005),
  // sonnet-5-5 cache read is $0.10/MTok (0.05× input, like opus-5-5) since the 2026-10-01 price-list term;
  // it read $0.20 until then. Caught by the peer's drift check two days before merge; verified 2026-10-08.
  rate('sonnet-5-5', 0.000002, 0.00001, 0.0000001),
  rate('sonnet-5', 0.000002, 0.00001, 0.0000002),
  rate('sonnet', 0.000003, 0.000015, 0.0000003),
  rate('haiku', 0.000001, 0.000005, 0.0000001),
  // Amazon Nova Micro — AWS Price List (AmazonBedrock, us-east-1, `USE1-NovaMicro-*`), read 2026-10-06:
  // $0.035 / $0.14 per MTok, cache read $0.00875 (0.25×), cache write $0.00 (no write charge).
  // Reached through untagged inference profiles that priced at $0 before feature-36 (qa F-PR68-002).
  rate('nova-micro', 0.000000035, 0.00000014, 0.00000000875, { m5: 0, h1: 0 }),
  // OpenAI models served on Bedrock (QA finding: gpt-5.6-sol usage priced to $0.00). Rates
  // follow the published GPT-5-family on-demand pricing ($1.25/M in, $10/M out, 0.1× cache
  // reads); confirm against aws.amazon.com/bedrock/pricing when adding successors. Cache writes:
  // the Bedrock prompt-caching guide (read 2026-10-08) bills GPT-5.6-and-later writes at 1.25× the
  // uncached input rate with one 30-minute TTL, so both TTL columns carry 1.25×; earlier GPT models
  // have implicit caching only, no published write fee, and 0 logged write tokens here → 0. (Cost
  // Explorer is silent on these models under the Bedrock service filter — no lines of any kind — so
  // it neither confirms nor refutes; the guide is the source.)
  rate('gpt-5.6-sol', 0.00000125, 0.00001, 0.000000125, { m5: 0.0000015625, h1: 0.0000015625 }),
  rate('gpt-5', 0.00000125, 0.00001, 0.000000125, { m5: 0, h1: 0 }),
];

const ZERO_RATE: ModelRate = rate('', 0, 0, 0);

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
  /** Every prompt-cache write token (Bedrock's `cacheWriteInputTokenCount`), whatever its TTL. */
  cacheWriteTokens?: number;
  /**
   * The TTL split of `cacheWriteTokens`, lifted from the logged response body by the aggregator
   * (`cacheWriteTtlOf` in ingestion/parse.ts). Their sum is ≤ `cacheWriteTokens`; the remainder is
   * "TTL unknown" — rows written before the aggregator read TTLs, bodies not logged, or Athena,
   * which cannot see the body at all. Unknown is priced at the 5-minute rate (the default TTL and
   * the only one this account has ever been billed) with the 1-hour price as the upper bound.
   */
  cacheWrite5mTokens?: number;
  cacheWrite1hTokens?: number;
}

/** The three stored cache-write counters of a rollup item, absent attributes reading as zero. */
export function cacheWriteOf(item: Record<string, unknown>): {
  cacheWriteTokens: number; cacheWrite5mTokens: number; cacheWrite1hTokens: number;
} {
  const num = (k: string) => { const v = Number(item[k] ?? 0); return Number.isFinite(v) ? v : 0; };
  return { cacheWriteTokens: num('cacheWriteTokens'), cacheWrite5mTokens: num('cacheWrite5mTokens'), cacheWrite1hTokens: num('cacheWrite1hTokens') };
}

export interface ModelCost {
  modelId: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Cache-write tokens whose TTL is not known; priced at 5 m in `estimatedUsd`, at 1 h in the bound. */
  cacheWriteUnknownTtlTokens: number;
  /** Includes cache writes. Standard-route ×1.1 is NOT applied (see the module header). */
  estimatedUsd: number;
  /** `estimatedUsd` with the unknown-TTL writes priced at the 1-hour rate. */
  estimatedUsdUpperBound: number;
  /** What the cache reads cost (the 0.1× line). */
  cacheReadUsd: number;
  /** What the cache writes cost (the whole line, premium included). */
  cacheWriteUsd: number;
  /** What the cache-read tokens WOULD have cost at full input price, minus what they did cost. */
  cacheSavingsUsd: number;
  /**
   * Net effect of prompt caching: `cacheSavingsUsd` minus the write premium (what the writes cost
   * over plain input). Negative means caching cost more than it saved in this window.
   */
  cacheNetUsd: number;
}

const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

/**
 * Cost for one model's token counts, all four billed lines. Savings = cache-read tokens priced
 * at full input rate minus their actual 0.1× cache rate — i.e. the money prompt caching saved.
 */
export function computeModelCost(t: TokenCounts, card: ModelRate[] = RATE_CARD): ModelCost {
  const rate = matchRate(t.modelId, card);
  const inTok = t.inputTokens ?? 0;
  const outTok = t.outputTokens ?? 0;
  const cacheTok = t.cacheReadTokens ?? 0;
  const cwTok = t.cacheWriteTokens ?? 0;
  const cw5m = t.cacheWrite5mTokens ?? 0;
  const cw1h = t.cacheWrite1hTokens ?? 0;
  // The parser only records a split that sums to the total, so this clamp is defensive: a split
  // larger than the total prices what it names and leaves nothing unknown.
  const cwUnknown = Math.max(0, cwTok - cw5m - cw1h);

  const cacheWriteUsd = (cw5m + cwUnknown) * rate.cacheWrite5mPerToken + cw1h * rate.cacheWrite1hPerToken;
  const cacheWriteUsdUpper = cw5m * rate.cacheWrite5mPerToken + (cw1h + cwUnknown) * rate.cacheWrite1hPerToken;
  const base = inTok * rate.inPerToken + outTok * rate.outPerToken + cacheTok * rate.cacheReadPerToken;
  // If those cache-read tokens had been charged as normal input tokens:
  const cacheAtFull = cacheTok * rate.inPerToken;
  const cacheAtActual = cacheTok * rate.cacheReadPerToken;
  const cacheSavingsUsd = cacheAtFull - cacheAtActual;
  const cacheReadUsd = cacheAtActual;
  // The premium is only the part of the write price ABOVE plain input; the tokens had to be sent anyway.
  const cacheWritePremiumUsd = cacheWriteUsd - cwTok * rate.inPerToken;

  return {
    modelId: t.modelId,
    inputTokens: inTok,
    outputTokens: outTok,
    cacheReadTokens: cacheTok,
    cacheWriteTokens: cwTok,
    cacheWriteUnknownTtlTokens: cwUnknown,
    estimatedUsd: round6(base + cacheWriteUsd),
    estimatedUsdUpperBound: round6(base + cacheWriteUsdUpper),
    cacheReadUsd: round6(cacheReadUsd),
    cacheWriteUsd: round6(cacheWriteUsd),
    cacheSavingsUsd: round6(cacheSavingsUsd),
    cacheNetUsd: round6(cacheSavingsUsd - cacheWritePremiumUsd),
  };
}

export interface CostSummary {
  byModel: ModelCost[];
  totalEstimatedUsd: number;
  totalEstimatedUsdUpperBound: number;
  totalCacheReadUsd: number;
  totalCacheWriteUsd: number;
  totalCacheSavingsUsd: number;
  totalCacheNetUsd: number;
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
  const merged = new Map<string, Required<TokenCounts>>();
  for (const raw of items) {
    const id = normalizeModelId(raw.modelId);
    const acc = merged.get(id) ?? {
      modelId: id, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0,
      cacheWriteTokens: 0, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0,
    };
    acc.inputTokens += raw.inputTokens ?? 0;
    acc.outputTokens += raw.outputTokens ?? 0;
    acc.cacheReadTokens += raw.cacheReadTokens ?? 0;
    acc.cacheWriteTokens += raw.cacheWriteTokens ?? 0;
    acc.cacheWrite5mTokens += raw.cacheWrite5mTokens ?? 0;
    acc.cacheWrite1hTokens += raw.cacheWrite1hTokens ?? 0;
    merged.set(id, acc);
  }
  const byModel = Array.from(merged.values())
    .filter((i) => i.inputTokens + i.outputTokens + i.cacheReadTokens + i.cacheWriteTokens > 0)
    .map((i) => computeModelCost(i, card));
  const sum = (pick: (m: ModelCost) => number) => round6(byModel.reduce((s, m) => s + pick(m), 0));
  return {
    byModel,
    totalEstimatedUsd: sum((m) => m.estimatedUsd),
    totalEstimatedUsdUpperBound: sum((m) => m.estimatedUsdUpperBound),
    totalCacheReadUsd: sum((m) => m.cacheReadUsd),
    totalCacheWriteUsd: sum((m) => m.cacheWriteUsd),
    totalCacheSavingsUsd: sum((m) => m.cacheSavingsUsd),
    totalCacheNetUsd: sum((m) => m.cacheNetUsd),
  };
}
