import { AdapterFields, num, obj, str } from './types';

/**
 * OpenTelemetry GenAI semantic conventions → canonical fields. Accepts both the current
 * `gen_ai.provider.name` and the older `gen_ai.system`, flat attribute maps (what otel-span.ts produces
 * from either the X-Ray Transaction Search shape or OTLP/JSON) and resource attributes.
 */
export function adaptOtel(attrs: Record<string, unknown>, resource: Record<string, unknown> = {}): AdapterFields & { vendor?: string; modelRequested?: string; modelResponded?: string } {
  const out: AdapterFields & { modelRequested?: string; modelResponded?: string } = {};
  const vendor = str(attrs['gen_ai.provider.name']) ?? str(attrs['gen_ai.system']);
  if (vendor) out.vendor = vendor.replace(/^aws\.bedrock$/, 'aws.bedrock');
  const reqModel = str(attrs['gen_ai.request.model']); if (reqModel) out.modelRequested = reqModel;
  const resModel = str(attrs['gen_ai.response.model']); if (resModel) out.modelResponded = resModel;
  out.model_id_raw = resModel ?? reqModel;
  const i = num(attrs['gen_ai.usage.input_tokens'] ?? attrs['gen_ai.usage.prompt_tokens']); if (i !== undefined) out.input_tokens = i;
  const o = num(attrs['gen_ai.usage.output_tokens'] ?? attrs['gen_ai.usage.completion_tokens']); if (o !== undefined) out.output_tokens = o;
  const cr = num(attrs['gen_ai.usage.cache_read.input_tokens'] ?? attrs['aws.bedrock.cache_read_tokens']); if (cr !== undefined) out.cache_read_tokens = cr;
  const cw = num(attrs['gen_ai.usage.cache_creation.input_tokens'] ?? attrs['aws.bedrock.cache_write_tokens']); if (cw !== undefined) out.cache_write_tokens = cw;
  const op = str(attrs['gen_ai.operation.name']); if (op) out.operation = op;
  const fr = attrs['gen_ai.response.finish_reasons'];
  if (Array.isArray(fr) && fr.length) out.finish_reason = String(fr[0]); else if (typeof fr === 'string') out.finish_reason = fr.replace(/^\[|\]$/g, '').split(',')[0].trim().replace(/^"|"$/g, '') || undefined;
  const rid = str(attrs['aws.request_id']) ?? str(attrs['gen_ai.response.id']) ?? str(attrs['aws.bedrock.request_id']); if (rid) out.request_id = rid;
  const sid = str(attrs['session.id']) ?? str(attrs['gen_ai.session.id']); if (sid) out.session_id = sid;
  const cid = str(attrs['gen_ai.conversation.id']); if (cid) out.conversation_id = cid;
  const svc = str(resource['service.name']) ?? str(attrs['service.name']); if (svc) out.service_name = svc;
  // semconv reports time_to_first_token in seconds
  const ttft = num(attrs['gen_ai.server.time_to_first_token']); if (ttft !== undefined) out.ttft_ms = ttft * 1000;
  return out;
}
