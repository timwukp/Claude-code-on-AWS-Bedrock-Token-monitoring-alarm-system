/**
 * Pure parsing of Cost Explorer usage types into (model, kind, route, region), so the daily bill can be
 * compared with what the invocation logs price (feature-40). No AWS calls; tested on the real names.
 *
 * Two naming schemes exist on this account's bill:
 *   USE1-anthropic.claude-opus-5-5-mantle-cache-write-tokens-1h-standard   (current; "-mantle-" is on EVERY
 *   model's usage type and is NOT a Bedrock-Mantle-endpoint marker — Mantle calls bill under these same lines)
 *   USE1-Claude4.6Sonnet-cache-read-input-token-count                      (legacy; no route suffix = standard)
 *   APS1-openai.gpt-6-luna-mantle-input-tokens-global-standard             (another region prefix)
 * Anything that does not fit is kept as kind 'other' — the collector never drops a billed line.
 */
/** cacheWrite30m is the OpenAI-on-Bedrock single TTL (billed 1.25× input, like the 5-minute Claude TTL). */
export type BillKind = 'input' | 'output' | 'cacheRead' | 'cacheWrite5m' | 'cacheWrite30m' | 'cacheWrite1h' | 'other';
export type BillRoute = 'global' | 'standard' | 'unknown';

export interface ParsedUsageType {
  /** Region prefix as billed, e.g. USE1, APS1; '' when absent. */
  region: string;
  /** Model as the rate card knows it (bare id or legacy family name), e.g. anthropic.claude-opus-5-5, claude-4-6-sonnet. */
  model: string;
  kind: BillKind;
  route: BillRoute;
}

/** Legacy "Claude4.6Sonnet" → a bare-id-like key the rate card's substring match understands ("claude-sonnet-4-6"). */
function legacyModel(name: string): string {
  const m = name.match(/^Claude(\d+(?:\.\d+)?)(Sonnet|Haiku|Opus)$/);
  if (!m) return name.toLowerCase();
  return `anthropic.claude-${m[2].toLowerCase()}-${m[1].replace('.', '-')}`;
}

export function parseUsageType(usageType: string): ParsedUsageType {
  const regionMatch = usageType.match(/^([A-Z]{2,4}\d)-(.*)$/);
  const region = regionMatch ? regionMatch[1] : '';
  const rest = regionMatch ? regionMatch[2] : usageType;

  // Current scheme: <model>-mantle-<kind words>[-1h][-global]-standard
  const cur = rest.match(/^(.*?)-mantle-(input-tokens|output-tokens|cache-read-tokens|cache-write-tokens(?:-1h|-30m)?)(?:-(global-standard|standard))?$/);
  if (cur) {
    const [, model, kindWords, routeWords] = cur;
    const kind: BillKind = kindWords === 'input-tokens' ? 'input'
      : kindWords === 'output-tokens' ? 'output'
        : kindWords === 'cache-read-tokens' ? 'cacheRead'
          : kindWords === 'cache-write-tokens-1h' ? 'cacheWrite1h'
            : kindWords === 'cache-write-tokens-30m' ? 'cacheWrite30m' : 'cacheWrite5m';
    const route: BillRoute = routeWords === 'global-standard' ? 'global' : routeWords === 'standard' ? 'standard' : 'unknown';
    return { region, model, kind, route };
  }

  // Legacy scheme: Claude4.6Sonnet-<kind words>[-cross-region-global]
  const leg = rest.match(/^(Claude[\d.]+(?:Sonnet|Haiku|Opus))-(input-tokens|output-tokens|cache-read-input-token-count|cache-write-input-token-count)(-cross-region-global)?$/);
  if (leg) {
    const [, name, kindWords, global] = leg;
    const kind: BillKind = kindWords === 'input-tokens' ? 'input'
      : kindWords === 'output-tokens' ? 'output'
        : kindWords === 'cache-read-input-token-count' ? 'cacheRead' : 'cacheWrite5m';
    return { region, model: legacyModel(name), kind, route: global ? 'global' : 'standard' };
  }

  return { region, model: rest.toLowerCase(), kind: 'other', route: 'unknown' };
}

/** One Cost Explorer line, as stored: pk BILL#DAILY, sk <day>#<usageType>. */
export interface BillLine extends ParsedUsageType {
  day: string; // YYYY-MM-DD
  usageType: string;
  usd: number;
  qty: number;
  /** Cost Explorer's own "Estimated" flag for the day; the collector re-reads recent days until it clears. */
  estimated: boolean;
}

/** Fold Cost Explorer's grouped result shape into BillLines (pure; the client call stays in the handler). */
export function billLinesFrom(results: {
  TimePeriod?: { Start?: string }; Estimated?: boolean;
  Groups?: { Keys?: string[]; Metrics?: Record<string, { Amount?: string }> }[];
}[]): BillLine[] {
  const out: BillLine[] = [];
  for (const r of results) {
    const day = r.TimePeriod?.Start ?? '';
    for (const g of r.Groups ?? []) {
      const usageType = g.Keys?.[0] ?? '';
      if (!day || !usageType) continue;
      const usd = Number(g.Metrics?.UnblendedCost?.Amount ?? 0);
      const qty = Number(g.Metrics?.UsageQuantity?.Amount ?? 0);
      if (!(usd > 0) && !(qty > 0)) continue; // CE emits zero rows for every usage type ever seen
      out.push({ day, usageType, usd, qty, estimated: !!r.Estimated, ...parseUsageType(usageType) });
    }
  }
  return out;
}
