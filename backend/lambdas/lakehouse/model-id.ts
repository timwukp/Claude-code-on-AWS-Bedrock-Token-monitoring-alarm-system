/**
 * One parser for every spelling Bedrock uses for a model: bare ids, `us./global./eu./apac.` system
 * inference profiles, inference-profile / application-inference-profile / provisioned-model /
 * custom-model / imported-model / foundation-model ARNs and Marketplace endpoints. Vendor-agnostic by
 * construction — an unknown vendor parses to `vendor: 'unknown'`, it never throws.
 *
 * `modelKey` follows the API's `normalizeModelId` (cost-calc.ts) and the UI's `canonical`
 * (model-names.ts): the ARN prefix and the route prefix are stripped, the version suffix is kept.
 */
export type ModelRoute = 'global' | 'us' | 'eu' | 'apac' | 'profile' | 'provisioned' | 'custom' | 'imported' | 'marketplace' | 'direct';
export type Modality = 'text' | 'embedding' | 'image' | 'video' | 'speech' | 'unknown';

export interface ParsedModelId {
  raw: string;
  modelKey: string;
  vendor: string;
  family: string;
  version: string | null;
  route: ModelRoute;
  aipArn: string | null;
  modality: Modality;
}

/** Vendor prefixes Bedrock offers, with the modality their models default to when the id does not say. */
export const VENDORS: Record<string, { name: string; defaultModality: Modality }> = {
  anthropic: { name: 'Anthropic', defaultModality: 'text' },
  openai: { name: 'OpenAI', defaultModality: 'text' },
  amazon: { name: 'Amazon', defaultModality: 'text' },
  meta: { name: 'Meta', defaultModality: 'text' },
  mistral: { name: 'Mistral AI', defaultModality: 'text' },
  cohere: { name: 'Cohere', defaultModality: 'text' },
  ai21: { name: 'AI21 Labs', defaultModality: 'text' },
  deepseek: { name: 'DeepSeek', defaultModality: 'text' },
  moonshot: { name: 'Moonshot AI', defaultModality: 'text' },
  moonshotai: { name: 'Moonshot AI', defaultModality: 'text' },
  qwen: { name: 'Qwen', defaultModality: 'text' },
  stability: { name: 'Stability AI', defaultModality: 'image' },
  luma: { name: 'Luma AI', defaultModality: 'video' },
  writer: { name: 'Writer', defaultModality: 'text' },
  twelvelabs: { name: 'TwelveLabs', defaultModality: 'video' },
};

const ROUTE_PREFIX = /^(us|global|eu|apac)\./;
const PROFILE_ID = /^[a-z0-9]{12}$/;
const ARN = /^arn:aws:([a-z0-9-]+):[a-z0-9-]*:\d*:([a-z-]+)\/(.*)$/;

/** Strip trailing date stamps and version suffixes: "-20251001-v1:0", "-v1:0", "-1:0", ":0". */
function baseName(model: string): string {
  return model.toLowerCase()
    .replace(/-\d{8}(-v\d+(:\d+)?)?$/, '')
    .replace(/-v\d+(:\d+)?$/, '')
    .replace(/-\d+:\d+$/, '')
    .replace(/:\d+$/, '');
}

function modalityOf(vendor: string, base: string): Modality {
  if (/embed/.test(base)) return 'embedding';
  if (/image|canvas|sd3|stable-diffusion|titan-image/.test(base)) return 'image';
  if (/reel|ray|video|pegasus|marengo/.test(base)) return 'video';
  if (/sonic|speech|tts|transcribe/.test(base)) return 'speech';
  return VENDORS[vendor]?.defaultModality ?? 'unknown';
}

function familyAndVersion(vendor: string, model: string): { family: string; version: string | null } {
  const base = baseName(model);
  if (vendor === 'anthropic') {
    const m = base.match(/^claude-([a-z]+)-([\d-]+)$/);
    if (m) return { family: `claude-${m[1]}`, version: m[2].replace(/-/g, '.') };
    return { family: base.replace(/-[\d.-]+$/, ''), version: null };
  }
  if (vendor === 'openai') {
    const m = base.match(/^(gpt-oss)-.*$/) ?? base.match(/^(gpt-\d+(?:\.\d+)?)(?:-.*)?$/);
    if (m) {
      const family = m[1];
      const v = family.match(/^gpt-(\d+(?:\.\d+)?)$/);
      return { family, version: v ? v[1] : null };
    }
    return { family: base, version: null };
  }
  if (vendor === 'amazon') {
    const m = base.match(/^(nova-[a-z]+|titan-[a-z]+)/);
    if (m) return { family: m[1], version: null };
    return { family: base, version: null };
  }
  if (vendor === 'meta') {
    const m = base.match(/^(llama\d+(?:\.\d+)?)/);
    return { family: m ? m[1] : base, version: null };
  }
  if (vendor === 'mistral') {
    const m = base.match(/^(ministral|mistral-large|mistral-small|mixtral|pixtral|codestral|mistral)/);
    return { family: m ? m[1] : base, version: null };
  }
  if (vendor === 'cohere') {
    const m = base.match(/^(command-r-plus|command-r|command|embed|rerank)/);
    return { family: m ? m[1] : base, version: null };
  }
  if (vendor === 'ai21') return { family: base.replace(/-[\d-]+.*$/, ''), version: null };
  if (vendor === 'deepseek') return { family: base.replace(/-.*$/, ''), version: null };
  if (vendor === 'moonshot' || vendor === 'moonshotai') {
    const m = base.match(/^(kimi-k\d+(?:\.\d+)?)/);
    return { family: m ? m[1] : base, version: null };
  }
  if (vendor === 'qwen') { const m = base.match(/^(qwen\d*(?:\.\d+)?)/); return { family: m ? m[1] : base, version: null }; }
  if (vendor === 'stability') { const m = base.match(/^(sd\d+|stable-[a-z]+)/); return { family: m ? m[1] : base, version: null }; }
  if (vendor === 'luma') return { family: base.replace(/-v?\d.*$/, ''), version: null };
  if (vendor === 'writer') return { family: base.replace(/-x?\d.*$/, ''), version: null };
  if (vendor === 'twelvelabs') return { family: base.replace(/-[\d-]+$/, ''), version: null };
  // Unknown vendor: first dash-separated word group before a digit.
  return { family: base.replace(/-v?\d.*$/, '') || base, version: null };
}

function parseBare(id: string, route: ModelRoute, raw: string, aipArn: string | null): ParsedModelId {
  const rest = id.replace(ROUTE_PREFIX, '');
  const routeFromPrefix = (id.match(ROUTE_PREFIX)?.[1] as ModelRoute | undefined);
  const effectiveRoute: ModelRoute = route === 'direct' && routeFromPrefix ? routeFromPrefix : route;
  if (PROFILE_ID.test(rest)) {
    return { raw, modelKey: rest, vendor: 'unknown', family: 'inference-profile', version: null, route: 'profile', aipArn: aipArn ?? null, modality: 'unknown' };
  }
  const dot = rest.indexOf('.');
  if (dot <= 0) return { raw, modelKey: rest, vendor: 'unknown', family: 'unknown', version: null, route: effectiveRoute, aipArn, modality: 'unknown' };
  const vendor = rest.slice(0, dot);
  const model = rest.slice(dot + 1);
  const { family, version } = familyAndVersion(vendor, model);
  return { raw, modelKey: rest, vendor, family, version, route: effectiveRoute, aipArn, modality: modalityOf(vendor, baseName(model)) };
}

export function parseModelId(raw: string): ParsedModelId {
  const s = (raw ?? '').trim();
  const m = s.match(ARN);
  if (!m) return parseBare(s, 'direct', raw, null);
  const [, service, kind, rest] = m;
  if (service === 'sagemaker' && kind === 'endpoint') {
    return { raw, modelKey: s, vendor: 'unknown', family: 'marketplace-endpoint', version: null, route: 'marketplace', aipArn: null, modality: 'unknown' };
  }
  switch (kind) {
    case 'application-inference-profile':
      return { raw, modelKey: s, vendor: 'unknown', family: 'inference-profile', version: null, route: 'profile', aipArn: s, modality: 'unknown' };
    case 'inference-profile':
    case 'foundation-model':
      return parseBare(rest, 'direct', raw, null);
    case 'provisioned-model':
      return { raw, modelKey: s, vendor: 'unknown', family: 'provisioned-model', version: null, route: 'provisioned', aipArn: null, modality: 'unknown' };
    case 'custom-model': {
      const baseId = rest.split('/')[0];
      const parsed = parseBare(baseId, 'custom', raw, null);
      return { ...parsed, route: 'custom' };
    }
    case 'imported-model':
      return { raw, modelKey: s, vendor: 'unknown', family: 'imported-model', version: null, route: 'imported', aipArn: null, modality: 'unknown' };
    case 'marketplace':
      return { raw, modelKey: s, vendor: 'unknown', family: 'marketplace-listing', version: null, route: 'marketplace', aipArn: null, modality: 'unknown' };
    default:
      return parseBare(rest, 'direct', raw, null);
  }
}
