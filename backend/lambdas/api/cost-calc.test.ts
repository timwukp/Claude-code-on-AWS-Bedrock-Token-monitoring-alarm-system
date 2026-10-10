import { matchRate, computeModelCost, summarizeCosts, routeMultiplier, routeCaseSql, RATE_CARD } from './cost-calc';

// Rate-arithmetic fixtures sit on the GLOBAL route (factor 1) so the expected dollars read straight off the card;
// the route factor has its own describe block below.
const OPUS = 'arn:aws:bedrock:us-east-1:123456789012:inference-profile/global.anthropic.claude-opus-4-8';
const FABLE = 'global.anthropic.claude-fable-5';
const FABLE_GLOBAL = 'global.anthropic.claude-fable-5';
const OPUS_BARE    = 'global.anthropic.claude-opus-4-8';

describe('matchRate', () => {
  it('matches opus-4-8 to the Opus rate', () => {
    expect(matchRate(OPUS).inPerToken).toBe(0.000005);
  });
  it('opus rate includes a defined cacheReadPerToken (not undefined)', () => {
    expect(matchRate(OPUS).cacheReadPerToken).toBe(0.0000005); // 0.1 × inPerToken
  });
  it('matches fable-5 to a non-zero rate (pricing entry must exist)', () => {
    expect(matchRate(FABLE).inPerToken).toBeGreaterThan(0);
    expect(matchRate(FABLE).outPerToken).toBeGreaterThan(0);
  });
  it('matches sonnet', () => {
    expect(matchRate('anthropic.claude-sonnet-4-6').outPerToken).toBe(0.000015);
  });
  it('returns zero rate for unknown models (cost shows 0, never wrong)', () => {
    const r = matchRate('some.unknown.model');
    expect(r.inPerToken).toBe(0);
    expect(r.cacheReadPerToken).toBe(0);
  });
});

describe('computeModelCost', () => {
  it('prices input + output + cache-read at the model rate', () => {
    const c = computeModelCost({ modelId: OPUS, inputTokens: 1000, outputTokens: 1000, cacheReadTokens: 0 });
    // 1000*5e-6 + 1000*25e-6 = 0.005 + 0.025 = 0.03
    expect(c.estimatedUsd).toBeCloseTo(0.03, 9);
    expect(c.cacheSavingsUsd).toBe(0);
  });

  it('computes cache savings = full-input price minus 0.1x cache price', () => {
    // 1,000,000 cache-read tokens on Opus: full input = 1e6*5e-6 = $5.00; actual = 1e6*5e-7 = $0.50
    const c = computeModelCost({ modelId: OPUS, inputTokens: 0, outputTokens: 0, cacheReadTokens: 1_000_000 });
    expect(c.cacheSavingsUsd).toBeCloseTo(4.5, 6); // $5.00 - $0.50
    expect(c.estimatedUsd).toBeCloseTo(0.5, 6);    // only the 0.1x charge
  });

  it('handles missing token fields as zero', () => {
    const c = computeModelCost({ modelId: OPUS });
    expect(c.estimatedUsd).toBe(0);
    expect(c.cacheSavingsUsd).toBe(0);
  });
});

describe('summarizeCosts', () => {
  it('totals estimated cost and cache savings across models', () => {
    const s = summarizeCosts([
      { modelId: OPUS, inputTokens: 0, outputTokens: 0, cacheReadTokens: 1_000_000 },
      { modelId: 'global.anthropic.claude-haiku-4-5', inputTokens: 1000, outputTokens: 0, cacheReadTokens: 0 },
    ]);
    expect(s.byModel).toHaveLength(2);
    expect(s.totalCacheSavingsUsd).toBeCloseTo(4.5, 6);
    // Opus 0.5 (cache) + Haiku 1000*1e-6 = 0.001 → 0.501
    expect(s.totalEstimatedUsd).toBeCloseTo(0.501, 6);
    // gross (pre-savings) must NOT be used as "Estimated spend" KPI; net ≠ gross
    expect(s.totalEstimatedUsd).not.toBeCloseTo(s.totalEstimatedUsd + s.totalCacheSavingsUsd, 2);
  });

  it('merges duplicate model rows and excludes zero-usage rows (F-003)', () => {
    const s = summarizeCosts([
      { modelId: OPUS,         inputTokens: 1000, outputTokens: 0, cacheReadTokens: 0 },
      { modelId: OPUS_BARE,    inputTokens: 1000, outputTokens: 0, cacheReadTokens: 0 }, // ARN vs bare id → same model
      { modelId: FABLE_GLOBAL, inputTokens: 500,  outputTokens: 0, cacheReadTokens: 0 },
      { modelId: FABLE_GLOBAL, inputTokens: 500,  outputTokens: 0, cacheReadTokens: 0 }, // exact duplicate → merged, not repeated
      { modelId: FABLE,        inputTokens: 0,    outputTokens: 0, cacheReadTokens: 0 }, // all-zero row → excluded from byModel
    ]);
    expect(s.byModel).toHaveLength(2); // 5 input rows → 2 distinct models ("Models used" KPI source)
    const opus = s.byModel.find((m) => m.modelId.includes('opus-4-8'))!;
    expect(opus.estimatedUsd).toBeCloseTo(0.01, 9); // (1000 + 1000) × 5e-6 summed into one row
  });
});

describe('point-release rates sit above their family row', () => {
  // AWS Price List, AmazonBedrockFoundationModels, us-east-1, Global standard, per MTok.
  it.each([
    ['global.anthropic.claude-sonnet-5-5', 2, 10, 0.1], // cache read 0.05× since the 2026-10-01 list term
    ['us.anthropic.claude-sonnet-5-20260801-v1:0', 2, 10, 0.2],
    ['global.anthropic.claude-opus-5-5', 4, 20, 0.2],
    ['global.anthropic.claude-fable-5-1', 10, 50, 0.25],
    ['global.anthropic.claude-mythos-5-1', 10, 50, 0.25],
  ])('%s is priced %d / %d / %d per MTok', (id, inM, outM, crM) => {
    const r = matchRate(id);
    expect(r.inPerToken * 1e6).toBeCloseTo(inM, 9);
    expect(r.outPerToken * 1e6).toBeCloseTo(outM, 9);
    expect(r.cacheReadPerToken * 1e6).toBeCloseTo(crM, 9);
  });

  it.each([
    ['global.anthropic.claude-fable-5', 'fable-5', 1],
    ['global.anthropic.claude-opus-5', 'opus', 0.5],
    ['anthropic.claude-sonnet-4-6', 'sonnet', 0.3],
  ])('%s keeps its family rate', (id, key, crM) => {
    const r = matchRate(id);
    expect(r.key).toBe(key);
    expect(r.cacheReadPerToken * 1e6).toBeCloseTo(crM, 9);
  });

  it('no row is shadowed by an earlier row whose key it contains', () => {
    RATE_CARD.forEach((r, i) => {
      const earlier = RATE_CARD.slice(0, i).find((e) => r.key.includes(e.key));
      expect(earlier?.key).toBeUndefined();
    });
  });
});

describe('cache writes are priced (feature-36)', () => {
  // AWS Price List, AmazonBedrockFoundationModels, us-east-1, Global standard, per MTok, read 2026-10-05:
  // cache-write 5-minute = 1.25 × input, 1-hour = 2 × input.
  it.each([
    ['global.anthropic.claude-fable-5-1', 12.5, 20],
    ['global.anthropic.claude-fable-5', 12.5, 20],
    ['global.anthropic.claude-opus-5-5', 5, 8],
    ['global.anthropic.claude-opus-5', 6.25, 10],
    ['us.anthropic.claude-opus-4-8', 6.25, 10],
    ['anthropic.claude-sonnet-4-6', 3.75, 6],
    ['global.anthropic.claude-sonnet-5-5', 2.5, 4],
    ['anthropic.claude-haiku-4-5', 1.25, 2],
  ])('%s cache write is %d (5 m) / %d (1 h) per MTok', (id, m5, h1) => {
    const r = matchRate(id);
    expect(r.cacheWrite5mPerToken * 1e6).toBeCloseTo(m5, 9);
    expect(r.cacheWrite1hPerToken * 1e6).toBeCloseTo(h1, 9);
  });

  it('every Anthropic row carries the published multiples of its own input rate', () => {
    for (const r of RATE_CARD.filter((x) => !x.key.startsWith('gpt') && !x.key.startsWith('nova'))) {
      expect(r.cacheWrite5mPerToken).toBeCloseTo(r.inPerToken * 1.25, 12);
      expect(r.cacheWrite1hPerToken).toBeCloseTo(r.inPerToken * 2, 12);
    }
    // The 1-hour column must still exist for rows whose model has a single TTL (GPT-5.6: 30 minutes).
    expect(matchRate('openai.gpt-5.6-sol').cacheWrite1hPerToken).toBe(matchRate('openai.gpt-5.6-sol').cacheWrite5mPerToken);
  });

  it('unknown models price cache writes at zero like every other kind', () => {
    const r = matchRate('some.unknown.model');
    expect(r.cacheWrite5mPerToken).toBe(0);
    expect(r.cacheWrite1hPerToken).toBe(0);
  });

  it('a known 5-minute write is 1.25× the input price and raises estimatedUsd', () => {
    // 1M cache-write tokens on Opus 4.8 at 5 m: 1e6 × 6.25e-6 = $6.25
    const c = computeModelCost({ modelId: OPUS, cacheWriteTokens: 1_000_000, cacheWrite5mTokens: 1_000_000 });
    expect(c.cacheWriteUsd).toBeCloseTo(6.25, 6);
    expect(c.estimatedUsd).toBeCloseTo(6.25, 6);
    expect(c.estimatedUsdUpperBound).toBeCloseTo(6.25, 6); // nothing unknown → no spread
    expect(c.cacheWriteUnknownTtlTokens).toBe(0);
  });

  it('a known 1-hour write is 2× the input price', () => {
    const c = computeModelCost({ modelId: OPUS, cacheWriteTokens: 1_000_000, cacheWrite1hTokens: 1_000_000 });
    expect(c.cacheWriteUsd).toBeCloseTo(10, 6);
  });

  it('unknown-TTL writes are priced at 5 m with the 1-hour price as the upper bound', () => {
    const c = computeModelCost({ modelId: OPUS, cacheWriteTokens: 1_000_000 });
    expect(c.cacheWriteUnknownTtlTokens).toBe(1_000_000);
    expect(c.estimatedUsd).toBeCloseTo(6.25, 6);
    expect(c.estimatedUsdUpperBound).toBeCloseTo(10, 6);
  });

  it('a partial split leaves only the remainder unknown', () => {
    const c = computeModelCost({
      modelId: OPUS, cacheWriteTokens: 1_000_000, cacheWrite5mTokens: 600_000, cacheWrite1hTokens: 100_000,
    });
    expect(c.cacheWriteUnknownTtlTokens).toBe(300_000);
    // 600k×6.25 + 100k×10 + 300k×6.25 (unknown at 5 m) = 3.75 + 1 + 1.875
    expect(c.cacheWriteUsd).toBeCloseTo(6.625, 6);
    // upper: 600k×6.25 + 400k×10 = 3.75 + 4
    expect(c.estimatedUsdUpperBound).toBeCloseTo(7.75, 6);
  });

  it('a split larger than the total is priced as named, with nothing unknown (defensive clamp)', () => {
    const c = computeModelCost({ modelId: OPUS, cacheWriteTokens: 100, cacheWrite5mTokens: 100, cacheWrite1hTokens: 50 });
    expect(c.cacheWriteUnknownTtlTokens).toBe(0);
    expect(c.cacheWriteUsd).toBeCloseTo(100 * 6.25e-6 + 50 * 10e-6, 12);
  });

  it('cacheNetUsd = cache-read savings minus the write premium over plain input', () => {
    // Opus 4.8: 1M reads save 1e6×(5e-6 − 5e-7) = $4.50; 1M 5 m writes cost $6.25, of which the
    // premium over plain input ($5.00) is $1.25 → net $3.25. Reads alone leave the old savings figure.
    const c = computeModelCost({
      modelId: OPUS, cacheReadTokens: 1_000_000, cacheWriteTokens: 1_000_000, cacheWrite5mTokens: 1_000_000,
    });
    expect(c.cacheSavingsUsd).toBeCloseTo(4.5, 6);
    expect(c.cacheReadUsd).toBeCloseTo(0.5, 6); // 1M × 5e-7 — the billed cache-read line
    expect(c.cacheNetUsd).toBeCloseTo(3.25, 6);
    const readsOnly = computeModelCost({ modelId: OPUS, cacheReadTokens: 1_000_000 });
    expect(readsOnly.cacheNetUsd).toBeCloseTo(readsOnly.cacheSavingsUsd, 9);
  });

  it('cacheNetUsd goes negative when writes outweigh reads', () => {
    // 1M writes (premium $1.25) against 100k reads (saving $0.45)
    const c = computeModelCost({
      modelId: OPUS, cacheReadTokens: 100_000, cacheWriteTokens: 1_000_000, cacheWrite5mTokens: 1_000_000,
    });
    expect(c.cacheNetUsd).toBeCloseTo(0.45 - 1.25, 6);
  });

  it('summarizeCosts keeps a cache-write-only row and sums the new totals', () => {
    const s = summarizeCosts([
      { modelId: OPUS, cacheWriteTokens: 1_000_000, cacheWrite5mTokens: 1_000_000 },
      { modelId: OPUS_BARE, cacheWriteTokens: 1_000_000 }, // same model, TTL unknown → merged
      { modelId: FABLE, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    ]);
    expect(s.byModel).toHaveLength(1); // the all-zero fable row is still dropped
    const opus = s.byModel[0];
    expect(opus.cacheWriteTokens).toBe(2_000_000);
    expect(opus.cacheWriteUnknownTtlTokens).toBe(1_000_000);
    expect(s.totalCacheWriteUsd).toBeCloseTo(12.5, 6);
    expect(s.totalCacheReadUsd).toBe(0);
    expect(s.totalEstimatedUsd).toBeCloseTo(12.5, 6);
    expect(s.totalEstimatedUsdUpperBound).toBeCloseTo(6.25 + 10, 6);
    expect(s.totalCacheNetUsd).toBeCloseTo(-(12.5 - 2_000_000 * 5e-6), 6);
  });

  it('GPT-5.6 writes cost 1.25× input on both TTL columns (one 30-minute TTL); earlier GPT rows cost 0', () => {
    // Bedrock prompt-caching guide, "GPT-5.6 and later models": writes billed at 1.25× the uncached input rate.
    const sol = matchRate('openai.gpt-5.6-sol');
    expect(sol.cacheWrite5mPerToken * 1e6).toBeCloseTo(1.5625, 9);
    expect(sol.cacheWrite1hPerToken * 1e6).toBeCloseTo(1.5625, 9);
    const old = matchRate('openai.gpt-5-2025');
    expect(old.key).toBe('gpt-5');
    expect(old.cacheWrite5mPerToken).toBe(0);
    expect(old.cacheWrite1hPerToken).toBe(0);
  });
});

describe('Nova Micro row (qa F-PR68-002: untagged-profile calls priced $0)', () => {
  // AWS Price List, AmazonBedrock, us-east-1, USE1-NovaMicro-* on-demand, read 2026-10-06.
  it('is priced $0.035 / $0.14 / $0.00875 per MTok with no cache-write charge', () => {
    const r = matchRate('amazon.nova-micro-v1:0');
    expect(r.key).toBe('nova-micro');
    expect(r.inPerToken * 1e6).toBeCloseTo(0.035, 9);
    expect(r.outPerToken * 1e6).toBeCloseTo(0.14, 9);
    expect(r.cacheReadPerToken * 1e6).toBeCloseTo(0.00875, 9);
    expect(r.cacheWrite5mPerToken).toBe(0);
    expect(r.cacheWrite1hPerToken).toBe(0);
  });
});

describe('route factor (feature-38): the card is the global tier, every other route is standard ×1.1', () => {
  const r = matchRate('anthropic.claude-opus-4-8');
  it.each([
    ['global.anthropic.claude-opus-4-8', 1],
    ['arn:aws:bedrock:us-east-1:123456789012:inference-profile/global.anthropic.claude-opus-4-8', 1],
    ['us.anthropic.claude-opus-4-8', 1.1],
    ['eu.anthropic.claude-opus-4-8', 1.1],
    ['apac.anthropic.claude-opus-4-8', 1.1],
    ['anthropic.claude-opus-4-8', 1.1],            // bare: direct single-region, or a profile resolved to its model
    ['arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.anthropic.claude-opus-4-8', 1.1],
  ])('%s → ×%d', (id, mult) => {
    expect(routeMultiplier(id, r)).toBe(mult);
  });
  it('OpenAI models on Bedrock have the two tiers too; Amazon Nova has one', () => {
    expect(routeMultiplier('us.openai.gpt-5.6-sol', matchRate('openai.gpt-5.6-sol'))).toBe(1.1);
    expect(routeMultiplier('global.openai.gpt-5.6-sol', matchRate('openai.gpt-5.6-sol'))).toBe(1);
    expect(matchRate('amazon.nova-micro-v1:0').routeTiers).toBe(false);
    expect(routeMultiplier('us.amazon.nova-pro-v1:0', matchRate('amazon.nova-pro-v1:0'))).toBe(1); // unknown model: $0, no tier
    expect(routeMultiplier('us.amazon.nova-micro-v1:0', matchRate('amazon.nova-micro-v1:0'))).toBe(1);
  });
  it('scales every dollar figure, never a token count', () => {
    const t = { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 1_000_000, cacheWriteTokens: 1_000_000, cacheWrite5mTokens: 400_000 };
    const g = computeModelCost({ modelId: 'global.anthropic.claude-opus-4-8', ...t });
    const s = computeModelCost({ modelId: 'us.anthropic.claude-opus-4-8', ...t });
    expect(g.routeMultiplier).toBe(1); expect(s.routeMultiplier).toBe(1.1);
    for (const k of ['estimatedUsd', 'estimatedUsdUpperBound', 'cacheReadUsd', 'cacheWriteUsd', 'cacheSavingsUsd', 'cacheNetUsd'] as const) {
      expect(s[k]).toBeCloseTo(g[k] * 1.1, 6);
    }
    for (const k of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'cacheWriteUnknownTtlTokens'] as const) {
      expect(s[k]).toBe(g[k]);
    }
    // the standard tier of Opus 4.8 input is $5.50/MTok on the Price List: 1M input tokens alone → $5.50
    expect(computeModelCost({ modelId: 'us.anthropic.claude-opus-4-8', inputTokens: 1_000_000 }).estimatedUsd).toBeCloseTo(5.5, 6);
  });
  it('summarizeCosts keeps us. and global. as separate rows, each at its own tier', () => {
    const s = summarizeCosts([
      { modelId: 'global.anthropic.claude-opus-4-8', inputTokens: 1_000_000 },
      { modelId: 'us.anthropic.claude-opus-4-8', inputTokens: 1_000_000 },
      { modelId: 'arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.anthropic.claude-opus-4-8', inputTokens: 1_000_000 }, // same row as the bare us.
    ]);
    expect(s.byModel).toHaveLength(2);
    expect(s.totalEstimatedUsd).toBeCloseTo(5 + 2 * 5.5, 6);
  });
});

describe('routeCaseSql mirrors routeMultiplier (feature-38)', () => {
  it('names the single-tier rows from the card and tests both id shapes for global', () => {
    const sql = routeCaseSql('m');
    expect(sql).toBe("CASE WHEN m LIKE '%nova-micro%' THEN 1 WHEN m LIKE 'global.%' OR m LIKE '%/global.%' THEN 1 ELSE 1.1 END");
  });
  it('with no single-tier rows the CASE has only the global test', () => {
    const card = RATE_CARD.filter((r) => r.routeTiers);
    expect(routeCaseSql('m', card)).toBe("CASE WHEN m LIKE 'global.%' OR m LIKE '%/global.%' THEN 1 ELSE 1.1 END");
  });
});
