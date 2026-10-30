import { Adapter, AdapterFields, chunks, lastChunk, num, obj, str } from './types';

/**
 * Anthropic Messages API on Bedrock (InvokeModel / InvokeModelWithResponseStream). Non-streaming: one
 * object with `usage` and `stop_reason`. Streaming: chunks — `message_start.message.usage` carries the
 * input side (incl. `cache_creation.ephemeral_5m/1h_input_tokens`), `message_delta` carries
 * `delta.stop_reason` and `usage.output_tokens`, `content_block_start` with type tool_use counts a tool call.
 */
export const anthropic: Adapter = {
  adapt(_family, requestBody, responseBody): AdapterFields {
    const out: AdapterFields = {};
    const req = obj(requestBody);
    const cs = chunks(responseBody);
    const usage = (() => {
      for (const c of cs) {
        const u = obj(c.usage) ?? obj(obj(c.message)?.usage);
        if (u && (u.input_tokens !== undefined || u.cache_creation_input_tokens !== undefined)) return u;
      }
      return undefined;
    })();
    if (usage) {
      const i = num(usage.input_tokens); if (i !== undefined) out.input_tokens = i;
      const cr = num(usage.cache_read_input_tokens); if (cr !== undefined) out.cache_read_tokens = cr;
      const cw = num(usage.cache_creation_input_tokens); if (cw !== undefined) out.cache_write_tokens = cw;
      const cc = obj(usage.cache_creation);
      if (cc) {
        const m5 = num(cc.ephemeral_5m_input_tokens) ?? 0; const h1 = num(cc.ephemeral_1h_input_tokens) ?? 0;
        if (m5 + h1 > 0) out.cache_write_ttl = h1 > 0 && m5 === 0 ? '1h' : m5 > 0 && h1 === 0 ? '5m' : 'unknown';
      }
    }
    // output tokens: non-streaming usage.output_tokens; streaming → the last usage that has it (message_delta)
    for (const c of [...cs].reverse()) {
      const u = obj(c.usage) ?? obj(obj(c.message)?.usage);
      const o = u ? num(u.output_tokens) : undefined;
      if (o !== undefined) { out.output_tokens = o; break; }
    }
    for (const c of [...cs].reverse()) {
      const sr = str(c.stop_reason) ?? str(obj(c.delta)?.stop_reason) ?? str(obj(c.message)?.stop_reason);
      if (sr) { out.finish_reason = sr; break; }
    }
    let tools = 0;
    for (const c of cs) {
      if (Array.isArray(c.content)) tools += c.content.filter((b: any) => obj(b)?.type === 'tool_use').length;
      if (c.type === 'content_block_start' && obj(c.content_block)?.type === 'tool_use') tools += 1;
    }
    if (tools > 0) out.tool_calls = tools;
    if (!out.cache_write_ttl && req) {
      const ttls = new Set<string>();
      const walk = (v: unknown, depth = 0) => {
        if (depth > 6 || !v || typeof v !== 'object') return;
        if (Array.isArray(v)) { v.forEach((x) => walk(x, depth + 1)); return; }
        const o = v as Record<string, unknown>;
        const cc = obj(o.cache_control);
        if (cc) ttls.add(str(cc.ttl) ?? '5m');
        for (const k of ['system', 'messages', 'content', 'tools']) if (k in o) walk(o[k], depth + 1);
      };
      walk(req);
      if (ttls.size === 1) out.cache_write_ttl = ttls.has('1h') ? '1h' : '5m';
    }
    const metrics = obj(lastChunk(responseBody)?.['amazon-bedrock-invocationMetrics']);
    if (metrics) { const l = num(metrics.invocationLatency); if (l !== undefined) out.latency_ms = l; const f = num(metrics.firstByteLatency); if (f !== undefined) out.ttft_ms = f; }
    return out;
  },
};
