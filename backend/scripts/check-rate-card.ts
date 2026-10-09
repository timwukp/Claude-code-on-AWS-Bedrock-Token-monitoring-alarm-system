/**
 * Compare the hand-written RATE_CARD with the AWS Price List for Amazon Bedrock foundation models.
 *
 *   AWS_REGION=us-east-1 npx tsx backend/scripts/check-rate-card.ts            # table + exit 1 on drift
 *   npx tsx backend/scripts/check-rate-card.ts --route regional                # compare the regional (us.) route
 *   npx tsx backend/scripts/check-rate-card.ts --json                          # machine-readable
 *
 * Why this exists: the rate card priced cache-READ tokens from day one and never priced cache-WRITE
 * tokens; nothing compared the card with the published list, so ~70 % of real spend went unpriced for
 * four months (2026-10 incident). The card is a copy of a public table; copies drift. This script is the
 * check that copy against its source — run it by hand, or wire it into CI once the CI role has
 * `pricing:GetProducts` (read-only, no cost).
 *
 * Price List shape (service code `AmazonBedrockFoundationModels`, verified 2026-10-06):
 *   product.attributes.servicename = "Claude Fable 5 (Amazon Bedrock Edition)"   ← the model
 *   product.attributes.usagetype   = "USE1-MP:USE1_CacheWrite1hInputTokenCount_Global-Units"
 *                                     ^ token kind + TTL + route live in this string
 *   terms.OnDemand.*.priceDimensions.*.pricePerUnit.USD per "1M tokens"
 */
import { PricingClient, GetProductsCommand } from '@aws-sdk/client-pricing';
import { RATE_CARD, ModelRate } from '../lambdas/api/cost-calc';

type Kind = 'input' | 'output' | 'cacheRead' | 'cacheWrite5m' | 'cacheWrite1h';
type Route = 'global' | 'regional' | 'batch' | 'other';

/** Card key → the Price List `servicename` prefix. Extend when a model is added to the card. */
const MODEL_NAMES: Record<string, string> = {
  'fable-5-1': 'Claude Fable 5.1',
  'fable-5': 'Claude Fable 5',
  'mythos-5-1': 'Claude Mythos 5.1',
  mythos: 'Claude Mythos 5',
  'opus-5-5': 'Claude Opus 5.5',
  'opus-4-8': 'Claude Opus 4.8',
  opus: 'Claude Opus 5',
  'sonnet-5-5': 'Claude Sonnet 5.5',
  'sonnet-5': 'Claude Sonnet 5',
  sonnet: 'Claude Sonnet 4.6',
  haiku: 'Claude Haiku 4.5',
};

function kindOf(usagetype: string): Kind | null {
  const u = usagetype.toLowerCase();
  if (u.includes('provisioned') || u.includes('long_ctx') || u.includes('longctx')) return null;
  if (u.includes('cachewrite1h') || u.includes('cache_write_tokens_1h')) return 'cacheWrite1h';
  if (u.includes('cachewrite') || u.includes('cache_write')) return 'cacheWrite5m';
  if (u.includes('cacheread') || u.includes('cache_read')) return 'cacheRead';
  if (u.includes('outputtokencount') || u.includes('output_tokens')) return 'output';
  if (u.includes('inputtokencount') || u.includes('input_tokens')) return 'input';
  return null;
}
function routeOf(usagetype: string): Route {
  const u = usagetype.toLowerCase();
  if (u.includes('batch')) return 'batch';
  if (u.includes('global')) return 'global';
  if (u.includes('cris') || u.includes('regional')) return 'regional';
  return 'other';
}

/** The card's rate for a kind, tolerant of the cache-write field names the card ends up using. */
function cardRate(r: ModelRate, kind: Kind): number | undefined {
  const rec = r as unknown as Record<string, number>;
  switch (kind) {
    case 'input': return rec.inPerToken;
    case 'output': return rec.outPerToken;
    case 'cacheRead': return rec.cacheReadPerToken;
    case 'cacheWrite5m': return Object.keys(rec).filter((k) => /cacheWrite/i.test(k) && !/1h/i.test(k) && /PerToken$/.test(k)).map((k) => rec[k])[0];
    case 'cacheWrite1h': return Object.keys(rec).filter((k) => /cacheWrite.*1h|1h.*cacheWrite/i.test(k) && /PerToken$/.test(k)).map((k) => rec[k])[0];
  }
}

async function fetchList(region: string): Promise<Map<string, Map<Kind, number>>> {
  const client = new PricingClient({ region: 'us-east-1' }); // the Pricing API itself lives in us-east-1 / ap-south-1
  const route: Route = process.argv.includes('--route') ? (process.argv[process.argv.indexOf('--route') + 1] as Route) : 'global';
  const byModel = new Map<string, Map<Kind, number>>();
  let NextToken: string | undefined;
  do {
    const res = await client.send(new GetProductsCommand({
      ServiceCode: 'AmazonBedrockFoundationModels', MaxResults: 100, NextToken,
      Filters: [{ Type: 'TERM_MATCH', Field: 'regionCode', Value: region }],
    }));
    for (const raw of res.PriceList ?? []) {
      const p = JSON.parse(String(raw));
      const name: string = p.product?.attributes?.servicename ?? '';
      const usagetype: string = p.product?.attributes?.usagetype ?? '';
      if (!name.startsWith('Claude')) continue;
      const kind = kindOf(usagetype); if (!kind || routeOf(usagetype) !== route) continue;
      for (const term of Object.values<any>(p.terms?.OnDemand ?? {})) {
        for (const dim of Object.values<any>(term.priceDimensions ?? {})) {
          if (dim.unit !== '1M tokens') continue;
          const perToken = Number(dim.pricePerUnit?.USD) / 1e6;
          const model = name.replace(/\s*\(Amazon Bedrock Edition\)\s*$/, '');
          const m = byModel.get(model) ?? new Map<Kind, number>();
          // several usagetypes can map to one kind (naming generations); keep the lowest — the standard rate
          m.set(kind, Math.min(m.get(kind) ?? Infinity, perToken));
          byModel.set(model, m);
        }
      }
    }
    NextToken = res.NextToken;
  } while (NextToken);
  return byModel;
}

async function main() {
  const region = process.env.AWS_REGION ?? 'us-east-1';
  const list = await fetchList(region);
  const rows: { model: string; kind: Kind; card: number | undefined; list: number | undefined; status: 'ok' | 'DRIFT' | 'UNPRICED' | 'NOT IN LIST' }[] = [];
  const kinds: Kind[] = ['input', 'output', 'cacheRead', 'cacheWrite5m', 'cacheWrite1h'];
  for (const r of RATE_CARD) {
    const name = MODEL_NAMES[r.key]; if (!name) continue; // OpenAI etc. are outside this check
    const l = list.get(name);
    for (const kind of kinds) {
      const card = cardRate(r, kind); const published = l?.get(kind);
      let status: typeof rows[number]['status'] = 'ok';
      if (published == null) status = 'NOT IN LIST';
      else if (card == null) status = 'UNPRICED';
      else if (Math.abs(card - published) > 1e-12) status = 'DRIFT';
      rows.push({ model: `${r.key} (${name})`, kind, card, list: published, status });
    }
  }
  const bad = rows.filter((x) => x.status === 'DRIFT' || x.status === 'UNPRICED');
  if (process.argv.includes('--json')) { console.log(JSON.stringify({ region, rows, drift: bad.length }, null, 1)); }
  else {
    const fmt = (n?: number) => (n == null ? '—' : `$${(n * 1e6).toFixed(4)}/M`);
    console.log(`Rate card vs AWS Price List (AmazonBedrockFoundationModels, ${region}, route=global)\n`);
    console.log(['model', 'kind', 'card', 'price list', 'status'].map((s) => s.padEnd(30)).join(''));
    for (const x of rows) console.log([x.model, x.kind, fmt(x.card), fmt(x.list), x.status].map((s) => String(s).padEnd(30)).join(''));
    console.log(`\n${bad.length === 0 ? 'OK — no drift, every kind the list prices is priced by the card.' : `${bad.length} problem(s): ${bad.map((b) => `${b.model} ${b.kind} ${b.status}`).join('; ')}`}`);
  }
  process.exit(bad.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(2); });
