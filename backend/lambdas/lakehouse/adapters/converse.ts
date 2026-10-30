import { Adapter, AdapterFields, chunks, num, obj, str } from './types';

/** Converse / ConverseStream (any vendor): `usage.{inputTokens,outputTokens,cacheReadInputTokens,cacheWriteInputTokens}`,
 *  `stopReason`, `metrics.latencyMs`, `output.message.content[].toolUse`; cache TTL from `usage.cacheDetails[].ttl` when present. */
export const converse: Adapter = {
  adapt(_family, _requestBody, responseBody): AdapterFields {
    const out: AdapterFields = {};
    const cs = chunks(responseBody);
    for (const c of [...cs].reverse()) {
      const u = obj(c.usage) ?? obj(obj(c.metadata)?.usage);
      if (u && out.input_tokens === undefined) {
        const i = num(u.inputTokens); if (i !== undefined) out.input_tokens = i;
        const o = num(u.outputTokens); if (o !== undefined) out.output_tokens = o;
        const cr = num(u.cacheReadInputTokens); if (cr !== undefined) out.cache_read_tokens = cr;
        const cw = num(u.cacheWriteInputTokens); if (cw !== undefined) out.cache_write_tokens = cw;
        if (Array.isArray(u.cacheDetails) && u.cacheDetails.length) {
          const ttls = new Set(u.cacheDetails.map((d: any) => str(obj(d)?.ttl)).filter(Boolean));
          out.cache_write_ttl = ttls.size === 1 ? (ttls.has('1h') ? '1h' : '5m') : 'unknown';
        }
      }
      const m = obj(c.metrics) ?? obj(obj(c.metadata)?.metrics);
      if (m && out.latency_ms === undefined) { const l = num(m.latencyMs); if (l !== undefined) out.latency_ms = l; }
      const sr = str(c.stopReason) ?? str(obj(c.messageStop)?.stopReason);
      if (sr && !out.finish_reason) out.finish_reason = sr;
    }
    let tools = 0;
    for (const c of cs) {
      const content = obj(obj(c.output)?.message)?.content;
      if (Array.isArray(content)) tools += content.filter((b: any) => obj(b)?.toolUse).length;
      if (obj(obj(c.contentBlockStart)?.start)?.toolUse) tools += 1;
    }
    if (tools > 0) out.tool_calls = tools;
    return out;
  },
};
