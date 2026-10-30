import { Adapter, AdapterFields, chunks, lastChunk, num, obj, str } from './types';

/**
 * OpenAI-compatible APIs on bedrock-runtime. Responses API: non-streaming object, or streamed chunks whose
 * `response` object (last chunk, `response.completed`) carries `usage.input_tokens_details.cached_tokens`,
 * `usage.output_tokens_details.reasoning_tokens`, `status`, and `output[]` items (`function_call` = tool call).
 * Chat Completions: `usage.prompt_tokens/completion_tokens`, `prompt_tokens_details.cached_tokens`,
 * `completion_tokens_details.reasoning_tokens`, `choices[].finish_reason`, `choices[].message.tool_calls`.
 */
export const openai: Adapter = {
  adapt(family, _requestBody, responseBody): AdapterFields {
    const out: AdapterFields = {};
    const cs = chunks(responseBody);
    if (family === 'openai_responses' || cs.some((c) => obj(c.response))) {
      let resp: Record<string, any> | undefined;
      for (const c of [...cs].reverse()) { resp = obj(c.response) ?? (c.object === 'response' ? c : undefined); if (resp) break; }
      if (!resp) return out;
      const u = obj(resp.usage);
      if (u) {
        const i = num(u.input_tokens); if (i !== undefined) out.input_tokens = i;
        const o = num(u.output_tokens); if (o !== undefined) out.output_tokens = o;
        const cached = num(obj(u.input_tokens_details)?.cached_tokens); if (cached !== undefined) out.cache_read_tokens = cached;
        const cw = num(obj(u.input_tokens_details)?.cache_write_tokens); if (cw !== undefined && cw > 0) { out.cache_write_tokens = cw; out.cache_write_ttl = '30m'; }
        const r = num(obj(u.output_tokens_details)?.reasoning_tokens); if (r !== undefined) out.reasoning_tokens = r;
      }
      const status = str(resp.status); if (status) out.finish_reason = status === 'completed' ? (str(obj(resp.incomplete_details)?.reason) ?? 'stop') : status;
      const tools = Array.isArray(resp.output) ? resp.output.filter((x: any) => /function_call|tool_call|mcp_call|computer_call/.test(String(obj(x)?.type ?? ''))).length : 0;
      if (tools > 0) out.tool_calls = tools;
      return out;
    }
    // Chat Completions (object or chunks with `choices`)
    for (const c of [...cs].reverse()) {
      const u = obj(c.usage);
      if (u && out.input_tokens === undefined) {
        const i = num(u.prompt_tokens); if (i !== undefined) out.input_tokens = i;
        const o = num(u.completion_tokens); if (o !== undefined) out.output_tokens = o;
        const cached = num(obj(u.prompt_tokens_details)?.cached_tokens); if (cached !== undefined) out.cache_read_tokens = cached;
        const r = num(obj(u.completion_tokens_details)?.reasoning_tokens); if (r !== undefined) out.reasoning_tokens = r;
      }
    }
    let tools = 0;
    for (const c of cs) for (const ch of Array.isArray(c.choices) ? c.choices : []) {
      const fr = str(obj(ch)?.finish_reason); if (fr) out.finish_reason = fr;
      const tc = obj(obj(ch)?.message)?.tool_calls ?? obj(obj(ch)?.delta)?.tool_calls;
      if (Array.isArray(tc)) tools += tc.length;
    }
    if (tools > 0) out.tool_calls = tools;
    const metrics = obj(lastChunk(responseBody)?.['amazon-bedrock-invocationMetrics']);
    if (metrics) { const l = num(metrics.invocationLatency); if (l !== undefined) out.latency_ms = l; }
    return out;
  },
};
