/**
 * Bedrock model identifiers arrive in three spellings for one model — `us.anthropic.claude-opus-5`,
 * `global.anthropic.claude-opus-5`, `anthropic.claude-opus-5-…` — and none of them is a name a
 * reader recognises. This module turns an id into a family (for colour), a friendly label, and a
 * region so the UI can show "Claude Opus 5 · us" and merge the variants into one row.
 */

export type ModelFamily =
  | 'claude-opus' | 'claude-sonnet' | 'claude-haiku' | 'claude-fable'
  | 'nova' | 'openai' | 'llama' | 'mistral' | 'deepseek' | 'kimi' | 'other';

export interface ParsedModel {
  raw: string;
  region: 'us' | 'global' | 'eu' | 'apac' | null;
  vendor: string;
  family: ModelFamily;
  friendly: string;
  /** Vendor+model without the region prefix — the key that merges `us.` / `global.` variants. */
  canonical: string;
}

const REGION_PREFIX = /^(us|global|eu|apac)\./;

function titleCase(s: string): string {
  return s.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function friendlyFor(vendor: string, model: string): { family: ModelFamily; friendly: string } {
  const m = model.toLowerCase();
  // Strip trailing date stamps and version suffixes: "-20251001-v1:0", "-v1:0", ":0".
  const base = m.replace(/-\d{8}(-v\d+(:\d+)?)?$/, '').replace(/-v\d+(:\d+)?$/, '').replace(/:\d+$/, '');
  const claude = base.match(/^claude-(opus|sonnet|haiku|fable)-([\d-]+)$/);
  if (vendor === 'anthropic' && claude) {
    const tier = claude[1];
    const ver = claude[2].replace(/-/g, '.');
    return { family: `claude-${tier}` as ModelFamily, friendly: `Claude ${titleCase(tier)} ${ver}` };
  }
  if (vendor === 'amazon' && base.startsWith('nova')) return { family: 'nova', friendly: `Amazon ${titleCase(base)}` };
  if (vendor === 'openai') return { family: 'openai', friendly: `OpenAI ${base.replace(/^gpt-/, 'GPT-')}` };
  if (vendor === 'meta') return { family: 'llama', friendly: `Meta ${titleCase(base)}` };
  if (vendor === 'mistral') return { family: 'mistral', friendly: `Mistral ${titleCase(base.replace(/^ministral-/, 'Ministral '))}` };
  if (vendor === 'deepseek') return { family: 'deepseek', friendly: `DeepSeek ${base.toUpperCase()}` };
  if (vendor === 'moonshot' || vendor === 'moonshotai') return { family: 'kimi', friendly: `Moonshot ${titleCase(base)}` };
  return { family: 'other', friendly: `${titleCase(vendor)} ${titleCase(base)}` };
}

/**
 * Strip an inference-profile ARN down to the id it routes — the same rule as the API's
 * `normalizeModelId` in cost-calc.ts, so a frontend list of ids matches a backend one.
 * `arn:aws:bedrock:…:inference-profile/us.anthropic.claude-opus-5` → `us.anthropic.claude-opus-5`.
 */
export function normalizeModelId(id: string): string {
  return id.replace(/^arn:[^/]+\/(?=.)/, '');
}

export function parseModelId(raw: string): ParsedModel {
  const regionMatch = raw.match(REGION_PREFIX);
  const region = (regionMatch?.[1] as ParsedModel['region']) ?? null;
  const rest = raw.replace(REGION_PREFIX, '');
  const dot = rest.indexOf('.');
  const vendor = dot > 0 ? rest.slice(0, dot) : 'unknown';
  const model = dot > 0 ? rest.slice(dot + 1) : rest;
  const { family, friendly } = friendlyFor(vendor, model);
  return { raw, region, vendor, family, friendly, canonical: rest };
}

export interface MergedModelRow<T> {
  canonical: string;
  friendly: string;
  family: ModelFamily;
  regions: string[];
  /** Distinct normalised ids behind this row — an ARN and the id it routes count once. */
  ids: string[];
  rows: T[];
}

/**
 * Group rows by canonical model, preserving the input rows for the caller to sum. Ids are normalised
 * first (ARN → routed id), so two source rows that name the same id — one as an inference-profile
 * ARN, one bare — land in one row and list that id once.
 */
export function mergeModelRows<T extends { modelId: string }>(rows: readonly T[]): MergedModelRow<T>[] {
  const by = new Map<string, MergedModelRow<T>>();
  for (const r of rows) {
    const id = normalizeModelId(r.modelId);
    const p = parseModelId(id);
    const e = by.get(p.canonical) ?? { canonical: p.canonical, friendly: p.friendly, family: p.family, regions: [], ids: [], rows: [] };
    if (p.region && !e.regions.includes(p.region)) e.regions.push(p.region);
    if (!e.ids.includes(id)) e.ids.push(id);
    e.rows.push(r);
    by.set(p.canonical, e);
  }
  return [...by.values()];
}

/** How many distinct normalised ids a set of merged rows spans — the one "ids" count every caption should use. */
export const countModelIds = <T>(merged: readonly MergedModelRow<T>[]): number => merged.reduce((n, g) => n + g.ids.length, 0);
