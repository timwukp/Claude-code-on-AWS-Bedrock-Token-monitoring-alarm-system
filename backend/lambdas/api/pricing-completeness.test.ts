import { readFileSync } from 'fs';
import { join } from 'path';
import { RATE_CARD, TokenCounts, computeModelCost } from './cost-calc';

/**
 * Every kind of token the parser extracts from a Bedrock invocation log must be priced by the rate
 * card, or be named here with the reason it is not.
 *
 * Why this test exists: from 2026-06-04 to 2026-10 the parser extracted `cacheWriteInputTokenCount`
 * and the hourly rollup stored it, but `ModelRate`/`TokenCounts`/`computeModelCost` had no cache-write
 * field, so 1.24 B tokens (≈ $10 k, ~70 % of real spend) were priced at $0 on every page — and every
 * cross-page reconciliation passed, because all pages shared the same incomplete card. Consistency
 * checks cannot find a kind that is missing everywhere; only a completeness check can.
 *
 * The token kinds are DERIVED from parse.ts so a new field added there fails here until it is priced.
 */

const PARSE_SRC = readFileSync(join(__dirname, '..', 'ingestion', 'parse.ts'), 'utf8');

/** Token kinds the parser can observe, as `TokenCounts` field names. */
function tokenKindsFromParser(): string[] {
  const block = PARSE_SRC.slice(PARSE_SRC.indexOf('export interface InvocationRecord'), PARSE_SRC.indexOf('export interface UsageAggregate'));
  const kinds = new Set<string>();
  for (const m of block.matchAll(/\b(\w+)TokenCount\??:/g)) {
    // inputTokenCount → inputTokens · outputTokenCount → outputTokens · cacheReadInputTokenCount → cacheReadTokens
    const name = m[1].replace(/Input$/, '');
    kinds.add(`${name}Tokens`);
  }
  return [...kinds].sort();
}

/** Kinds the parser sees but the card deliberately does not price. Each needs a reason. Keep it empty if you can. */
const UNPRICED_BY_DESIGN: Record<string, string> = {};

/**
 * Rows whose cache-WRITE rate is legitimately zero, with the published rule that says so. Any other row
 * with a zero cache-write rate is a defect (the 2026-10 omission, per model).
 * Source: docs.aws.amazon.com/bedrock/latest/userguide/prompt-caching.html, read 2026-10-08.
 */
const CACHE_WRITE_FREE: Record<string, string> = {
  'gpt-5': 'OpenAI GPT-5.5 and earlier on Bedrock: "Cache writes have no additional fee on these models"',
  'nova-micro': 'Amazon Nova: implicit prompt caching only; no cache-write rate is published',
};

describe('rate card completeness — every observed token kind is priced', () => {
  const kinds = tokenKindsFromParser();

  it('derives the token kinds from parse.ts (guard against the regex silently matching nothing)', () => {
    expect(kinds).toEqual(expect.arrayContaining(['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens']));
  });

  for (const kind of kinds) {
    const reason = UNPRICED_BY_DESIGN[kind];
    it(`${kind}: ${reason ? `unpriced by design — ${reason}` : 'a non-zero count alone must produce a non-zero cost on a priced model'}`, () => {
      if (reason) return;
      const counts = { modelId: 'anthropic.claude-opus-5', [kind]: 1_000_000 } as unknown as TokenCounts;
      const cost = computeModelCost(counts);
      expect(cost.estimatedUsd).toBeGreaterThan(0);
    });
  }

  it('every rate-card row prices every observed kind (no row can zero out a kind the others price)', () => {
    const zeros: string[] = [];
    for (const rate of RATE_CARD) {
      for (const kind of kinds) {
        if (UNPRICED_BY_DESIGN[kind]) continue;
        if (kind === 'cacheWriteTokens' && CACHE_WRITE_FREE[rate.key]) continue;
        const counts = { modelId: rate.key, [kind]: 1_000_000 } as unknown as TokenCounts;
        if (!(computeModelCost(counts, [rate]).estimatedUsd > 0)) zeros.push(`${rate.key}:${kind}`);
      }
    }
    // Each entry is a model × kind that is silently free — exactly how the cache-write omission looked, row by row.
    expect(zeros).toEqual([]);
  });

  it('CACHE_WRITE_FREE names only rows that exist on the card (a renamed row must not keep an exemption alive)', () => {
    for (const key of Object.keys(CACHE_WRITE_FREE)) expect(RATE_CARD.map((r) => r.key)).toContain(key);
  });

  it('cache writes cost MORE than plain input, never less (Bedrock bills 1.25× for 5-minute, 2× for 1-hour TTL)', () => {
    if (UNPRICED_BY_DESIGN.cacheWriteTokens) return;
    const model = 'anthropic.claude-opus-5';
    const input = computeModelCost({ modelId: model, inputTokens: 1_000_000 }).estimatedUsd;
    const write = computeModelCost({ modelId: model, cacheWriteTokens: 1_000_000 } as unknown as TokenCounts).estimatedUsd;
    expect(write).toBeGreaterThanOrEqual(input * 1.25 - 1e-9);
  });
});
