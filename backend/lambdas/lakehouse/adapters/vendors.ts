import { Adapter, AdapterFields, chunks, lastChunk, num, obj, str } from './types';

function metrics(body: unknown, out: AdapterFields): void {
  const m = obj(lastChunk(body)?.['amazon-bedrock-invocationMetrics']);
  if (!m) return;
  const l = num(m.invocationLatency); if (l !== undefined) out.latency_ms = l;
  const f = num(m.firstByteLatency); if (f !== undefined) out.ttft_ms = f;
}

/** Meta Llama native InvokeModel: `prompt_token_count`, `generation_token_count`, `stop_reason`. */
export const meta: Adapter = {
  adapt(_f, _req, body): AdapterFields {
    const out: AdapterFields = {};
    for (const c of chunks(body)) {
      const p = num(c.prompt_token_count); if (p !== undefined) out.input_tokens = p;
      const g = num(c.generation_token_count); if (g !== undefined) out.output_tokens = g;
      const s = str(c.stop_reason); if (s) out.finish_reason = s;
    }
    metrics(body, out); return out;
  },
};

/** Mistral native: `usage.{prompt_tokens,completion_tokens}` (chat) or `outputs[].stop_reason` (completion). */
export const mistral: Adapter = {
  adapt(_f, _req, body): AdapterFields {
    const out: AdapterFields = {};
    for (const c of chunks(body)) {
      const u = obj(c.usage);
      if (u) { const p = num(u.prompt_tokens); if (p !== undefined) out.input_tokens = p; const g = num(u.completion_tokens); if (g !== undefined) out.output_tokens = g; }
      for (const ch of Array.isArray(c.choices) ? c.choices : []) { const fr = str(obj(ch)?.finish_reason); if (fr) out.finish_reason = fr; }
      for (const o of Array.isArray(c.outputs) ? c.outputs : []) { const sr = str(obj(o)?.stop_reason); if (sr) out.finish_reason = sr; }
    }
    metrics(body, out); return out;
  },
};

/** Cohere Command native: `meta.billed_units.{input_tokens,output_tokens}`, `finish_reason`. */
export const cohere: Adapter = {
  adapt(_f, _req, body): AdapterFields {
    const out: AdapterFields = {};
    for (const c of chunks(body)) {
      const bu = obj(obj(c.meta)?.billed_units) ?? obj(obj(obj(c.meta)?.tokens));
      if (bu) { const i = num(bu.input_tokens); if (i !== undefined) out.input_tokens = i; const o = num(bu.output_tokens); if (o !== undefined) out.output_tokens = o; }
      const fr = str(c.finish_reason); if (fr) out.finish_reason = fr;
      if (Array.isArray(c.tool_calls) && c.tool_calls.length) out.tool_calls = c.tool_calls.length;
    }
    metrics(body, out); return out;
  },
};

/** AI21 Jamba (OpenAI-like chat): `usage.{prompt_tokens,completion_tokens}`, `choices[].finish_reason`. */
export const ai21: Adapter = {
  adapt(_f, _req, body): AdapterFields {
    const out: AdapterFields = {};
    for (const c of chunks(body)) {
      const u = obj(c.usage);
      if (u) { const p = num(u.prompt_tokens); if (p !== undefined) out.input_tokens = p; const g = num(u.completion_tokens); if (g !== undefined) out.output_tokens = g; }
      for (const ch of Array.isArray(c.choices) ? c.choices : []) { const fr = str(obj(ch)?.finish_reason); if (fr) out.finish_reason = fr; }
    }
    metrics(body, out); return out;
  },
};

/** Amazon Titan embeddings: request `inputText`, response `inputTextTokenCount`; no output tokens. */
export const titanEmbeddings: Adapter = {
  adapt(_f, _req, body): AdapterFields {
    const out: AdapterFields = { modality: 'embedding' };
    for (const c of chunks(body)) { const n = num(c.inputTextTokenCount); if (n !== undefined) out.input_tokens = n; }
    if (out.input_tokens !== undefined) out.output_tokens = 0;
    metrics(body, out); return out;
  },
};

/** Fallback for vendors we have no body knowledge of: envelope only. */
export const generic: Adapter = { adapt: () => ({}) };
