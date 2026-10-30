import { SilverInvocationsRow } from '../generated/row-types';

/** The silver.invocations row minus the bookkeeping the transform fills in itself. */
export type CanonicalFields = Omit<SilverInvocationsRow, 'ingest_ts'>;

export type ApiFamily = 'invoke' | 'converse' | 'openai_responses' | 'openai_chat' | 'embeddings' | 'image' | 'other';

/** What an adapter may contribute: the vocabulary is the silver row's; token counts are compared with the envelope. */
export type AdapterFields = Partial<Pick<CanonicalFields,
  'input_tokens' | 'output_tokens' | 'cache_read_tokens' | 'cache_write_tokens' | 'cache_write_ttl' | 'reasoning_tokens' | 'tool_calls'
  | 'finish_reason' | 'latency_ms' | 'ttft_ms' | 'modality' | 'model_id_raw' | 'request_id' | 'session_id' | 'conversation_id'
  | 'trace_id' | 'span_id' | 'service_name' | 'vendor' | 'operation' | 'event_ts'>>;

export interface Adapter {
  /** Never throws; returns {} when the body says nothing it understands. */
  adapt(apiFamily: ApiFamily, requestBody: unknown, responseBody: unknown): AdapterFields;
}

export const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined);
export const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined);
export const obj = (v: unknown): Record<string, any> | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, any>) : undefined);
/** Streaming bodies are logged as an array of chunks; non-streaming as one object. */
export const chunks = (body: unknown): Record<string, any>[] => (Array.isArray(body) ? body.filter((c) => c && typeof c === 'object') : obj(body) ? [obj(body)!] : []);
export const lastChunk = (body: unknown): Record<string, any> | undefined => { const c = chunks(body); return c[c.length - 1]; };
