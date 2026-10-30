/**
 * bronze → silver.invocations: one vendor-neutral row per call.
 *
 * Value order, per field:
 *   1. the Bedrock envelope — what the service itself logged: modelId, identity.arn, operation,
 *      requestMetadata, the four token counts, and `amazon-bedrock-invocationMetrics` (latency/TTFT)
 *      lifted with `latencyOf`, plus the cache-write TTL split lifted with `cacheWriteTtlOf`;
 *   2. the vendor adapter — fills only what the envelope lacks (finish reason, reasoning tokens, tool
 *      calls, cache TTL from body usage, latency for non-Bedrock sources). When the adapter reports a
 *      token count that differs from the envelope, the envelope wins and the pair is recorded as a
 *      discrepancy (→ silver.adapter_audit);
 *   3. the registry / rate card — project_id + attribution_source via `deriveProject`, price_status via
 *      `matchRate` (dim_model refines it later in SQL).
 * The same row shape is produced from an OTel span (`buildSilverRowFromSpan`, source 'otel'); the
 * silver MERGE joins the two on request_id.
 */
import { InvocationRecord, AttributionMaps, cacheWriteTtlOf, deriveProject, latencyOf, lookupIdentityHint } from '../ingestion/parse';
import { matchRate, normalizeModelId } from '../api/cost-calc';
import { adapt, adaptOtel, ApiFamily, CanonicalFields } from './adapters';
import { num, obj, str } from './adapters/types';
import { parseModelId } from './model-id';
import { tenantKeyOf } from './tenant-key';
import { flattenAttributes } from './otel-span';
import { SilverAdapterAuditRow, SilverInvocationsRow } from './generated/row-types';

export interface SilverBuildOptions { maps?: AttributionMaps; ingestTs: string }

export interface SilverBuild { row: SilverInvocationsRow; audit: SilverAdapterAuditRow[] }

export type RawRecord = InvocationRecord & {
  input?: InvocationRecord['input'] & { inputBodyJson?: unknown; inputBodyS3Path?: string };
};

export function apiFamilyOf(rec: RawRecord): ApiFamily {
  const op = rec.operation ?? '';
  if (/^Converse/.test(op)) return 'converse';
  const model = (rec.modelId ?? '').toLowerCase();
  const body = obj(rec.input?.inputBodyJson);
  if (/^Responses|^InvokeModel.*Responses|CreateResponse/.test(op)) return 'openai_responses';
  if (/ChatCompletion/.test(op)) return 'openai_chat';
  if (body) {
    if ('anthropic_version' in body || (Array.isArray(body.messages) && body.messages.some((m: any) => Array.isArray(obj(m)?.content) && (obj(m)!.content as any[]).some((c: any) => obj(c)?.type)))) return 'invoke';
    if (/openai\./.test(model) && 'input' in body) return 'openai_responses';
    if (/openai\./.test(model) && Array.isArray(body.messages)) return 'openai_chat';
    if ('inputText' in body || 'texts' in body) return 'embeddings';
    if ('taskType' in body && /image/i.test(String(body.taskType))) return 'image';
  }
  if (/embed/.test(model)) return 'embeddings';
  if (/stability|luma|titan-image|nova-canvas|nova-reel/.test(model)) return 'image';
  return op.startsWith('InvokeModel') ? 'invoke' : 'other';
}

function attributionSource(rec: RawRecord, maps: AttributionMaps | undefined, projectId: string): SilverInvocationsRow['attribution_source'] {
  if (projectId === 'untagged') return 'none';
  const viaProfile = maps?.profiles.get(rec.modelId);
  if (viaProfile && viaProfile.projectId === projectId) return 'aip';
  if (rec.requestMetadata?.project_id === projectId) return 'metadata';
  const arn = rec.identity?.arn;
  if (arn && maps && lookupIdentityHint(arn, maps.identities) === projectId) return 'identity';
  return 'none';
}

function ttlOf(rec: RawRecord): string | null {
  const split = cacheWriteTtlOf(rec);
  const total = rec.input?.cacheWriteInputTokenCount ?? 0;
  if (total <= 0) return null;
  if (!split) return 'unknown';
  if (split.h1 > 0 && split.m5 === 0) return '1h';
  if (split.m5 > 0 && split.h1 === 0) return '5m';
  return 'unknown';
}

/** When the model id hides the vendor (an application-inference-profile ARN with no cache entry), the body shape usually does not. */
export function inferVendorFromBody(family: ApiFamily, requestBody: unknown, responseBody: unknown): string | undefined {
  const ib = obj(requestBody);
  const cs = Array.isArray(responseBody) ? responseBody : responseBody ? [responseBody] : [];
  const first = obj(cs[0]);
  if (family === 'openai_responses' || family === 'openai_chat') return 'openai';
  if (ib && ('anthropic_version' in ib || 'anthropic_beta' in ib)) return 'anthropic';
  if (first && (first.type === 'message' || first.type === 'message_start' || obj(first.message)?.type === 'message')) return 'anthropic';
  if (ib && typeof ib.model === 'string') { const v = parseModelId(ib.model).vendor; if (v !== 'unknown') return v; }
  if (first && typeof first.model === 'string') { const v = parseModelId(first.model).vendor; if (v !== 'unknown') return v; }
  if (first && ('prompt_token_count' in first || 'generation_token_count' in first)) return 'meta';
  if (first && 'inputTextTokenCount' in first) return 'amazon';
  if (first && obj(first.meta)?.billed_units) return 'cohere';
  return undefined;
}

export function buildSilverRow(rec: RawRecord, opts: SilverBuildOptions): SilverBuild {
  const ts = new Date(rec.timestamp).toISOString();
  const { projectId, effectiveModelId } = deriveProject(rec, opts.maps);
  const raw = parseModelId(rec.modelId);
  const eff = effectiveModelId !== rec.modelId ? parseModelId(effectiveModelId) : raw;
  const family = apiFamilyOf(rec);
  const vendor = eff.vendor !== 'unknown' ? eff.vendor : raw.vendor !== 'unknown' ? raw.vendor
    : (inferVendorFromBody(family, rec.input?.inputBodyJson, rec.output?.outputBodyJson) ?? 'unknown');
  const adapted = adapt(vendor, family, rec.input?.inputBodyJson, rec.output?.outputBodyJson);
  const tenant = tenantKeyOf(rec.identity?.arn, rec.requestMetadata?.tenant);

  const envelope = {
    input_tokens: num(rec.input?.inputTokenCount),
    output_tokens: num(rec.output?.outputTokenCount),
    cache_read_tokens: num(rec.input?.cacheReadInputTokenCount),
    cache_write_tokens: num(rec.input?.cacheWriteInputTokenCount),
  };
  const audit: SilverAdapterAuditRow[] = [];
  const pick = (field: keyof typeof envelope): number | undefined => {
    const e = envelope[field]; const a = adapted[field] ?? undefined;
    if (e !== undefined && a !== undefined && e !== a) {
      audit.push({ event_ts: ts, event_day: ts.slice(0, 10), request_id: rec.requestId, vendor, api_family: family, field, envelope_value: String(e), adapter_value: String(a) });
    }
    return e ?? a;
  };
  const inputTokens = pick('input_tokens'); const outputTokens = pick('output_tokens');
  const tokenSource = envelope.input_tokens !== undefined || envelope.output_tokens !== undefined ? 'envelope' : (adapted.input_tokens !== undefined || adapted.output_tokens !== undefined ? 'adapter' : 'envelope');
  const lat = latencyOf(rec);
  const rate = matchRate(normalizeModelId(effectiveModelId));
  const row: SilverInvocationsRow = {
    event_ts: ts,
    event_day: ts.slice(0, 10),
    request_id: rec.requestId,
    source: 'bedrock',
    operation: rec.operation ?? null,
    api_family: family,
    model_id_raw: rec.modelId,
    model_key: eff.modelKey,
    vendor,
    family: eff.family,
    version: eff.version,
    modality: adapted.modality ?? eff.modality,
    route: raw.route,
    aip_arn: raw.aipArn,
    underlying_model_id: effectiveModelId !== rec.modelId ? effectiveModelId : eff.modelKey,
    identity_arn: rec.identity?.arn ?? null,
    tenant_key: tenant.tenantKey,
    caller_type: tenant.callerType,
    project_id: projectId,
    attribution_source: attributionSource(rec, opts.maps, projectId),
    input_tokens: inputTokens ?? 0,
    output_tokens: outputTokens ?? 0,
    cache_read_tokens: pick('cache_read_tokens') ?? null,
    cache_write_tokens: pick('cache_write_tokens') ?? null,
    cache_write_ttl: ttlOf(rec) ?? adapted.cache_write_ttl ?? null,
    reasoning_tokens: adapted.reasoning_tokens ?? null,
    tool_calls: adapted.tool_calls ?? null,
    finish_reason: adapted.finish_reason ?? null,
    latency_ms: lat?.e2eMs ?? adapted.latency_ms ?? null,
    ttft_ms: lat?.ttfbMs ?? adapted.ttft_ms ?? null,
    body_s3_path: str(rec.input?.inputBodyS3Path) ?? null,
    token_source: tokenSource,
    adapter_discrepancy: audit.length > 0,
    price_status: rate.key !== '' ? 'priced' : 'unpriced_public',
    session_id: null,
    conversation_id: null,
    trace_id: null,
    span_id: null,
    service_name: null,
    ingest_ts: opts.ingestTs,
  };
  return { row, audit };
}

/** Which OTel span is a model call (and not an HTTP hop or a tool span). */
export function isGenAiSpan(span: Record<string, any>): boolean {
  const attrs = flattenAttributes(span.attributes);
  return Object.keys(attrs).some((k) => k.startsWith('gen_ai.'));
}

export function buildSilverRowFromSpan(span: Record<string, any>, opts: SilverBuildOptions): SilverBuild | null {
  const attrs = flattenAttributes(span.attributes);
  const res = flattenAttributes(span.resource?.attributes);
  const a = adaptOtel(attrs, res);
  const startNanos = span.startTimeUnixNano; const endNanos = span.endTimeUnixNano;
  const toMs = (n: unknown): number | null => { try { return n === undefined || n === null ? null : Number(BigInt(String(n).split('.')[0]) / 1_000_000n); } catch { return null; } };
  const startMs = toMs(startNanos); if (startMs === null) return null;
  const ts = new Date(startMs).toISOString();
  const endMs = toMs(endNanos);
  const modelRaw = a.modelResponded ?? a.modelRequested ?? 'unknown';
  const parsed = parseModelId(modelRaw);
  const providerVendor = a.vendor && !/aws\.bedrock|^aws$|bedrock/i.test(a.vendor) ? a.vendor.split('.').pop()! : undefined;
  const vendor = parsed.vendor !== 'unknown' ? parsed.vendor : (providerVendor ?? 'unknown');
  const rate = matchRate(normalizeModelId(modelRaw));
  const requestId = a.request_id ?? String(span.spanId);
  const row: SilverInvocationsRow = {
    event_ts: ts, event_day: ts.slice(0, 10), request_id: requestId, source: 'otel',
    operation: a.operation ?? (typeof span.name === 'string' ? span.name : null), api_family: a.operation === 'embeddings' ? 'embeddings' : 'other',
    model_id_raw: modelRaw, model_key: parsed.modelKey, vendor, family: parsed.family, version: parsed.version, modality: parsed.modality,
    route: parsed.route, aip_arn: parsed.aipArn, underlying_model_id: parsed.modelKey,
    identity_arn: null, tenant_key: a.service_name ? `service/${a.service_name}` : 'unknown', caller_type: a.service_name ? 'service' : 'unknown',
    project_id: 'untagged', attribution_source: 'none',
    input_tokens: a.input_tokens ?? 0, output_tokens: a.output_tokens ?? 0, cache_read_tokens: a.cache_read_tokens ?? null, cache_write_tokens: a.cache_write_tokens ?? null,
    cache_write_ttl: null, reasoning_tokens: null, tool_calls: null, finish_reason: a.finish_reason ?? null,
    latency_ms: endMs !== null ? endMs - startMs : null, ttft_ms: a.ttft_ms ?? null, body_s3_path: null,
    token_source: 'otel', adapter_discrepancy: false, price_status: rate.key !== '' ? 'priced' : 'unpriced_public',
    session_id: a.session_id ?? null, conversation_id: a.conversation_id ?? null,
    trace_id: String(span.traceId), span_id: String(span.spanId), service_name: a.service_name ?? null,
    ingest_ts: opts.ingestTs,
  };
  return { row, audit: [] };
}
