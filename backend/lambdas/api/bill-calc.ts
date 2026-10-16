/**
 * Billed vs what the logs price (feature-40). Pure — the readers in costs.ts / overview.ts fetch the
 * three inputs and this module does the arithmetic:
 *   billed          — Cost Explorer lines the daily collector stored (BILL#DAILY), the exact dollar source;
 *   loggedEstimate  — the same PROJDAY rows the pages price, restricted to the days the bill covers;
 *   unlogged        — billed − loggedEstimate: spend the invocation logs never saw. Since 2026-10-06 that
 *                     is Bedrock Mantle traffic, which bills under the ordinary usage types; its CloudWatch
 *                     counts are attached as the explanation, never multiplied by a rate (its token metric
 *                     has no cache split and would overstate the figure ~6×).
 * Both sides are grouped by the rate card's key (matchRate), so `us.`/`global.`/profile-resolved rows of one
 * model meet the bill's one line per model.
 */
import { matchRate, normalizeModelId } from './cost-calc';

export interface BillLineItem { day: string; model: string; kind: string; route: string; usd: number; qty: number }
export interface MantleCounts { inferences: number; clientErrors: number; inputTokens: number; outputTokens: number }

export interface BillModelRow {
  model: string;
  billedUsd: number;
  byKind: { input: number; output: number; cacheRead: number; cacheWrite: number; other: number };
  loggedEstimateUsd: number;
  unloggedUsd: number;
  /** Our logged estimate exceeded the bill for this model — an over-estimate on our side, surfaced not hidden. */
  overEstimated?: boolean;
  mantle: { inferences: number; inputTokens: number; outputTokens: number } | null;
}

export interface BillBlock {
  window: { from: string; to: string; daysBilled: number; billedFrom: string | null; billedTo: string | null }; // from/to = requested; billedFrom/To = days Cost Explorer actually has (it lags ~1 day)
  asOf: string | null;
  byModel: BillModelRow[];
  totalBilledUsd: number;
  totalLoggedEstimateUsd: number;
  totalUnloggedUsd: number;
  /** loggedEstimate ÷ billed, in percent; null when nothing is billed in the window. */
  loggedSharePct: number | null;
  /** Both dollar sides are ACCOUNT-wide (the bill has no tenant); the pages' other figures are the viewer's tenant. */
  scope: 'account';
  /** The viewer's tenant's share of the logged estimate on the same billed days — so the two scopes can be read together. */
  tenantLoggedEstimateUsd: number | null;
  dollarsSource: 'cost-explorer';
  tokensSource: 'cloudwatch';
  note: string;
}

export const BILL_NOTE = 'Account-wide: the bill has no tenant, so both sides here sum every tenant; the other figures on this '
  + 'page are this tenant alone. Unlogged = billed − what the invocation logs price. Bedrock Mantle calls bill under the same '
  + 'usage types but never reach the invocation log, so they have no cache split and no project attribution; their '
  + 'CloudWatch counts are shown as the explanation and are not priced. Cost Explorer lags about a day.';

const round2 = (n: number) => Math.round(n * 100) / 100;

/** The grouping key both sides share: the card row, or the normalized id when the card has none. */
export function billModelKey(modelId: string): string {
  const id = normalizeModelId(modelId);
  return matchRate(id).key || id;
}

/**
 * @param lines   stored bill lines (any day; this filters to the window)
 * @param logged  per model key → per day → logged estimate USD (already priced by the card, all tenants)
 * @param mantle  per CloudWatch `Model` → counts for the window (bare ids; keyed through billModelKey here)
 */
export function buildBill(
  lines: BillLineItem[],
  logged: Map<string, Map<string, number>>,
  mantle: Map<string, MantleCounts>,
  window: { from: string; to: string },
  asOf: string | null,
  tenantLogged?: Map<string, number> | null, // the viewer's tenant: day → USD (any model)
): BillBlock {
  const inWindow = lines.filter((l) => l.day >= window.from && l.day <= window.to);
  const days = new Set(inWindow.map((l) => l.day));
  const rows = new Map<string, BillModelRow>();
  const row = (key: string): BillModelRow => {
    const r = rows.get(key) ?? { model: key, billedUsd: 0, byKind: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, other: 0 }, loggedEstimateUsd: 0, unloggedUsd: 0, mantle: null };
    rows.set(key, r); return r;
  };
  for (const l of inWindow) {
    const r = row(billModelKey(l.model));
    r.billedUsd += l.usd;
    const k = l.kind === 'cacheWrite5m' || l.kind === 'cacheWrite1h' ? 'cacheWrite' : (l.kind as keyof BillModelRow['byKind']);
    r.byKind[k in r.byKind ? k : 'other'] += l.usd;
  }
  // The logged side only for the days the bill covers — the two sides must describe the same days.
  for (const [key, perDay] of logged) {
    let usd = 0; for (const [d, v] of perDay) if (days.has(d)) usd += v;
    if (usd > 0) row(billModelKey(key)).loggedEstimateUsd += usd;
  }
  for (const [model, c] of mantle) {
    if (c.inferences <= 0) continue;
    const r = row(billModelKey(model));
    r.mantle = { inferences: (r.mantle?.inferences ?? 0) + c.inferences, inputTokens: (r.mantle?.inputTokens ?? 0) + c.inputTokens, outputTokens: (r.mantle?.outputTokens ?? 0) + c.outputTokens };
  }
  let billed = 0, loggedTotal = 0, unlogged = 0;
  const byModel = [...rows.values()].map((r) => {
    const diff = r.billedUsd - r.loggedEstimateUsd;
    const out: BillModelRow = {
      ...r,
      billedUsd: round2(r.billedUsd),
      byKind: Object.fromEntries(Object.entries(r.byKind).map(([k, v]) => [k, round2(v)])) as BillModelRow['byKind'],
      loggedEstimateUsd: round2(r.loggedEstimateUsd),
      unloggedUsd: round2(Math.max(0, diff)),
    };
    if (diff < -0.005) out.overEstimated = true;
    billed += r.billedUsd; loggedTotal += r.loggedEstimateUsd; unlogged += Math.max(0, diff);
    return out;
  }).sort((a, b) => b.billedUsd - a.billedUsd);
  let tenantUsd: number | null = null;
  if (tenantLogged) { tenantUsd = 0; for (const [d, v] of tenantLogged) if (days.has(d)) tenantUsd += v; tenantUsd = round2(tenantUsd); }
  return {
    window: { from: window.from, to: window.to, daysBilled: days.size, billedFrom: days.size ? [...days].sort()[0] : null, billedTo: days.size ? [...days].sort().at(-1)! : null },
    asOf,
    scope: 'account',
    tenantLoggedEstimateUsd: tenantUsd,
    byModel,
    totalBilledUsd: round2(billed),
    totalLoggedEstimateUsd: round2(loggedTotal),
    totalUnloggedUsd: round2(unlogged),
    loggedSharePct: billed > 0 ? Math.round((Math.min(loggedTotal, billed) / billed) * 1000) / 10 : null,
    dollarsSource: 'cost-explorer',
    tokensSource: 'cloudwatch',
    note: BILL_NOTE,
  };
}

/**
 * Mantle's `Model` series summed vs the undimensioned fleet series: the two must agree. A gap > 1% means a
 * series was missed or double-counted (the AWS/Bedrock trap), and the caller flags the block rather than
 * trusting either number.
 */
export function mantleConsistent(perModel: Map<string, MantleCounts>, fleetInferences: number): boolean {
  const sum = [...perModel.values()].reduce((s, c) => s + c.inferences, 0);
  if (sum === 0 && fleetInferences === 0) return true;
  return Math.abs(sum - fleetInferences) <= Math.max(1, 0.01 * fleetInferences);
}
