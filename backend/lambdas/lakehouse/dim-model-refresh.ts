/**
 * silver.dim_model: every model id the account can call, rebuilt daily. Pure `buildDimModel` turns the
 * Bedrock control-plane listings into rows (vendor/family/version/modality via parseModelId; price_status
 * from the rate card: priced when a row matches, unpriced_private for custom/imported/provisioned/
 * marketplace models the Price List cannot know, unpriced_public otherwise). The handler lists and
 * replaces the table in one DELETE + INSERT.
 */
import { AthenaClient } from '@aws-sdk/client-athena';
import { BedrockClient, ListCustomModelsCommand, ListFoundationModelsCommand, ListImportedModelsCommand, ListInferenceProfilesCommand, ListProvisionedModelThroughputsCommand } from '@aws-sdk/client-bedrock';
import { isPriced, matchRate, normalizeModelId } from '../api/cost-calc';
import { SilverDimModelRow } from './generated/row-types';
import { parseModelId } from './model-id';
import { AthenaRunner, insertStatements, silverTableRef, sqlString, sqlTimestamp } from './athena-writer';

export interface FoundationModelSummary { modelId: string; providerName?: string; inputModalities?: string[]; outputModalities?: string[]; modelLifecycle?: { status?: string } }
export interface InferenceProfileSummary { inferenceProfileId?: string; inferenceProfileArn: string; type?: string; models?: Array<{ modelArn?: string }> }
export interface ProvisionedSummary { provisionedModelArn: string; modelArn?: string; status?: string }
export interface CustomModelSummary { modelArn: string; baseModelArn?: string }
export interface ImportedModelSummary { modelArn: string }

const modalityOf = (mods: string[] | undefined, fallback: SilverDimModelRow['modality']) => {
  const m = (mods ?? []).map((x) => x.toUpperCase());
  if (m.includes('EMBEDDING')) return 'embedding';
  if (m.includes('IMAGE') && !m.includes('TEXT')) return 'image';
  if (m.includes('VIDEO')) return 'video';
  if (m.includes('SPEECH')) return 'speech';
  if (m.includes('TEXT')) return 'text';
  return fallback;
};

export function buildDimModel(
  foundation: FoundationModelSummary[], profiles: InferenceProfileSummary[], provisioned: ProvisionedSummary[],
  custom: CustomModelSummary[], imported: ImportedModelSummary[], refreshedAt: string,
): SilverDimModelRow[] {
  const rows = new Map<string, SilverDimModelRow>();
  const put = (id: string, extra: Partial<SilverDimModelRow>, privateModel = false) => {
    const p = parseModelId(id);
    const key = p.modelKey;
    if (rows.has(key) && !extra.input_modalities) return; // first (richest) description wins
    const rate = matchRate(normalizeModelId(p.route === 'profile' && p.aipArn ? id : p.modelKey));
    // A custom / imported / provisioned model is billed by its own contract, never by the public card.
    const priced = !privateModel && rate.key !== '' && isPriced(p.modelKey);
    rows.set(key, {
      model_key: key, vendor: extra.vendor ?? p.vendor, family: extra.family ?? p.family, version: extra.version ?? p.version, modality: extra.modality ?? p.modality,
      input_modalities: extra.input_modalities ?? null, output_modalities: extra.output_modalities ?? null,
      lifecycle: extra.lifecycle ?? null,
      price_status: priced ? 'priced' : privateModel ? 'unpriced_private' : 'unpriced_public',
      rate_card_key: priced ? rate.key : null,
      refreshed_at: refreshedAt,
    });
  };
  for (const f of foundation) {
    put(f.modelId, {
      modality: modalityOf(f.outputModalities ?? f.inputModalities, parseModelId(f.modelId).modality),
      input_modalities: JSON.stringify(f.inputModalities ?? []), output_modalities: JSON.stringify(f.outputModalities ?? []),
      lifecycle: f.modelLifecycle?.status ?? null,
    });
  }
  for (const pr of profiles) {
    const underlying = pr.models?.[0]?.modelArn;
    const id = pr.type === 'APPLICATION' || !pr.inferenceProfileId ? pr.inferenceProfileArn : pr.inferenceProfileId;
    if (underlying && !rows.has(parseModelId(id).modelKey)) {
      const u = parseModelId(underlying);
      const base = rows.get(u.modelKey);
      // a profile is a route onto a model: it inherits the model's vendor/family/version
      put(id, { vendor: u.vendor, family: u.family, version: u.version, modality: base?.modality ?? u.modality, lifecycle: base?.lifecycle ?? null, input_modalities: base?.input_modalities ?? undefined, output_modalities: base?.output_modalities ?? undefined });
    } else put(id, {});
  }
  for (const p of provisioned) {
    const u = p.modelArn ? parseModelId(p.modelArn) : null;
    put(p.provisionedModelArn, { lifecycle: p.status ?? null, ...(u && u.vendor !== 'unknown' ? { vendor: u.vendor, family: u.family, version: u.version, modality: u.modality } : {}) }, true);
  }
  for (const c of custom) put(c.modelArn, {}, true);
  for (const i of imported) put(i.modelArn, {}, true);
  return [...rows.values()].sort((a, b) => a.model_key.localeCompare(b.model_key));
}

export function dimModelStatements(tableBucket: string, rows: SilverDimModelRow[]): string[] {
  const ref = silverTableRef(tableBucket, 'dim_model');
  const cols = ['model_key', 'vendor', 'family', 'version', 'modality', 'input_modalities', 'output_modalities', 'lifecycle', 'price_status', 'rate_card_key', 'refreshed_at'];
  const values = rows.map((r) => [r.model_key, r.vendor, r.family, r.version, r.modality, r.input_modalities, r.output_modalities, r.lifecycle, r.price_status, r.rate_card_key].map(sqlString).concat(sqlTimestamp(r.refreshed_at)));
  return [`DELETE FROM ${ref}`, ...insertStatements(ref, cols, values)];
}

async function listAll<T>(fn: (token?: string) => Promise<{ items: T[]; next?: string }>): Promise<T[]> {
  const out: T[] = []; let token: string | undefined;
  do { const page = await fn(token); out.push(...page.items); token = page.next; } while (token);
  return out;
}

export const handler = async (): Promise<{ rows: number }> => {
  const bedrock = new BedrockClient({});
  const [fm, profiles, prov, custom, imported] = await Promise.all([
    bedrock.send(new ListFoundationModelsCommand({})).then((r) => (r.modelSummaries ?? []) as FoundationModelSummary[]),
    listAll<InferenceProfileSummary>(async (t) => { const r = await bedrock.send(new ListInferenceProfilesCommand({ nextToken: t })); return { items: (r.inferenceProfileSummaries ?? []) as InferenceProfileSummary[], next: r.nextToken }; }),
    listAll<ProvisionedSummary>(async (t) => { const r = await bedrock.send(new ListProvisionedModelThroughputsCommand({ nextToken: t })); return { items: (r.provisionedModelSummaries ?? []) as ProvisionedSummary[], next: r.nextToken }; }),
    listAll<CustomModelSummary>(async (t) => { const r = await bedrock.send(new ListCustomModelsCommand({ nextToken: t })); return { items: (r.modelSummaries ?? []) as CustomModelSummary[], next: r.nextToken }; }),
    listAll<ImportedModelSummary>(async (t) => { const r = await bedrock.send(new ListImportedModelsCommand({ nextToken: t })); return { items: (r.modelSummaries ?? []) as ImportedModelSummary[], next: r.nextToken }; }),
  ]);
  const rows = buildDimModel(fm, profiles, prov, custom, imported, new Date().toISOString());
  const runner = new AthenaRunner(new AthenaClient({}), process.env.ATHENA_WORKGROUP!, process.env.ATHENA_OUTPUT);
  for (const sql of dimModelStatements(process.env.TABLE_BUCKET!, rows)) await runner.run(sql);
  console.log(JSON.stringify({ dim_model_rows: rows.length, priced: rows.filter((r) => r.price_status === 'priced').length }));
  return { rows: rows.length };
};
