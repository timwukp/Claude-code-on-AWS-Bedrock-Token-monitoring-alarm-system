import { ai21, cohere, generic, meta, mistral, titanEmbeddings } from './vendors';
import { anthropic } from './anthropic';
import { converse } from './converse';
import { openai } from './openai';
import { Adapter, AdapterFields, ApiFamily } from './types';

export { adaptOtel } from './otel';
export type { AdapterFields, ApiFamily, CanonicalFields } from './types';

/**
 * (vendor, api_family) → adapter. Converse normalises every vendor, so it is chosen by family first;
 * otherwise the vendor's native body format decides. Anything unknown falls back to `generic`
 * (envelope only), so a new vendor never changes the silver schema and never breaks the pipeline.
 */
const BY_VENDOR: Record<string, Adapter> = {
  anthropic, openai, meta, mistral, cohere, ai21,
};

export function adapterFor(vendor: string, apiFamily: ApiFamily): Adapter {
  if (apiFamily === 'converse') return converse;
  if (apiFamily === 'openai_responses' || apiFamily === 'openai_chat') return openai;
  if (apiFamily === 'embeddings' && vendor === 'amazon') return titanEmbeddings;
  return BY_VENDOR[vendor] ?? generic;
}

/** Never throws. */
export function adapt(vendor: string, apiFamily: ApiFamily, requestBody: unknown, responseBody: unknown): AdapterFields {
  try {
    const out = adapterFor(vendor, apiFamily).adapt(apiFamily, requestBody, responseBody);
    return out && typeof out === 'object' ? out : {};
  } catch {
    return {};
  }
}
