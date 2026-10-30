import * as fs from 'fs';
import * as path from 'path';
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import fc from 'fast-check';
import { buildSilverRow, buildSilverRowFromSpan, apiFamilyOf, RawRecord } from './canonical';
import { adapt, adapterFor } from './adapters';
import { AttributionMaps } from '../ingestion/parse';

const FIXTURES = path.join(__dirname, 'fixtures', 'adapters');
const SPEC = path.resolve(__dirname, '..', '..', '..', 'spec', 'lakehouse', 'silver.invocations.schema.json');
const NOW = '2026-10-30T00:00:00.000Z';

function fixtures(): Array<{ vendor: string; family: string; record: RawRecord; expected: Record<string, unknown> }> {
  const out: Array<{ vendor: string; family: string; record: RawRecord; expected: Record<string, unknown> }> = [];
  for (const vendor of fs.readdirSync(FIXTURES)) for (const family of fs.readdirSync(path.join(FIXTURES, vendor))) {
    const dir = path.join(FIXTURES, vendor, family);
    out.push({ vendor, family, record: JSON.parse(fs.readFileSync(path.join(dir, 'record.json'), 'utf8')), expected: JSON.parse(fs.readFileSync(path.join(dir, 'expected.json'), 'utf8')) });
  }
  return out;
}

const schema = JSON.parse(fs.readFileSync(SPEC, 'utf8'));
const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
// The JSON Schema says `type: string` for nullable optionals; a row carries null for "absent", so validate with nulls stripped.
const stripNulls = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null));
const { $id: _id, ...schemaNoId } = schema; void _id;
const validate = ajv.compile(schemaNoId);

describe('silver.invocations from golden fixtures (every vendor and API family)', () => {
  const cases = fixtures();
  it('has a fixture for every adapter we ship', () => {
    const dirs = cases.map((c) => `${c.vendor}/${c.family}`);
    for (const must of ['anthropic/invoke', 'anthropic/converse', 'openai/openai_responses', 'openai/openai_chat', 'meta/invoke', 'mistral/invoke', 'cohere/invoke', 'ai21/invoke', 'amazon/embeddings', 'unknown/invoke']) {
      expect(dirs).toContain(must);
    }
  });

  it.each(cases.map((c) => [`${c.vendor}/${c.family}`, c] as const))('%s → a row that validates against the spec and matches its expected fields', (_name, c) => {
    const { row, audit } = buildSilverRow(c.record, { ingestTs: NOW });
    const ok = validate(stripNulls(row as unknown as Record<string, unknown>));
    expect(ok ? [] : validate.errors).toEqual([]);
    for (const [k, v] of Object.entries(c.expected)) expect({ [k]: (row as any)[k] }).toEqual({ [k]: v });
    expect(row.adapter_discrepancy).toBe(audit.length > 0);
    // never a body in silver
    expect(JSON.stringify(row)).not.toMatch(/\[redacted\]/);
  });
});

describe('three-layer value order', () => {
  const base = fixtures().find((c) => c.vendor === 'anthropic' && c.family === 'invoke')!.record;

  it('the envelope wins over the adapter and the disagreement is audited', () => {
    const rec: RawRecord = JSON.parse(JSON.stringify(base));
    rec.input!.inputTokenCount = 999; // adapter (body usage) says 686
    const { row, audit } = buildSilverRow(rec, { ingestTs: NOW });
    expect(row.input_tokens).toBe(999);
    expect(row.token_source).toBe('envelope');
    expect(audit).toEqual([expect.objectContaining({ field: 'input_tokens', envelope_value: '999', adapter_value: '686', vendor: 'anthropic', api_family: 'invoke' })]);
    expect(row.adapter_discrepancy).toBe(true);
  });

  it('attribution: aip tier when the profile cache knows the project', () => {
    const maps: AttributionMaps = { profiles: new Map([[base.modelId, { projectId: 'proj-a', underlyingModelId: 'us.anthropic.claude-opus-5-5' }]]), identities: new Map() };
    const { row } = buildSilverRow(base, { ingestTs: NOW, maps });
    expect(row).toMatchObject({ project_id: 'proj-a', attribution_source: 'aip', underlying_model_id: 'us.anthropic.claude-opus-5-5', model_key: 'anthropic.claude-opus-5-5', vendor: 'anthropic', route: 'profile' });
  });

  it('attribution: metadata tier, identity tier (role hint covers every session), none', () => {
    const rec: RawRecord = { ...JSON.parse(JSON.stringify(base)), modelId: 'us.anthropic.claude-opus-5-5', requestMetadata: { project_id: 'proj-m' } };
    expect(buildSilverRow(rec, { ingestTs: NOW }).row).toMatchObject({ project_id: 'proj-m', attribution_source: 'metadata' });
    const sess: RawRecord = { ...JSON.parse(JSON.stringify(base)), modelId: 'us.anthropic.claude-opus-5-5', identity: { arn: 'arn:aws:sts::123456789012:assumed-role/llmops-harness-execution/BedrockAgentCore-abc' } };
    const maps: AttributionMaps = { profiles: new Map(), identities: new Map([['arn:aws:iam::123456789012:role/llmops-harness-execution', 'llmops-agentic-system']]) };
    expect(buildSilverRow(sess, { ingestTs: NOW, maps }).row).toMatchObject({ project_id: 'llmops-agentic-system', attribution_source: 'identity', tenant_key: 'arn:aws:iam::123456789012:role/llmops-harness-execution', caller_type: 'role' });
    const none: RawRecord = { ...JSON.parse(JSON.stringify(base)), modelId: 'us.anthropic.claude-opus-5-5', requestMetadata: undefined };
    expect(buildSilverRow(none, { ingestTs: NOW }).row).toMatchObject({ project_id: 'untagged', attribution_source: 'none' });
  });

  it('a Bedrock API-key user is an api_key_user tenant; price_status follows the rate card', () => {
    const rec: RawRecord = { ...JSON.parse(JSON.stringify(base)), modelId: 'us.anthropic.claude-opus-5-5', identity: { arn: 'arn:aws:iam::123456789012:user/BedrockAPIKey-yq3t' } };
    const { row } = buildSilverRow(rec, { ingestTs: NOW });
    expect(row).toMatchObject({ caller_type: 'api_key_user', price_status: 'priced' });
    const unk: RawRecord = { ...rec, modelId: 'moonshotai.kimi-k2.5' };
    expect(buildSilverRow(unk, { ingestTs: NOW }).row).toMatchObject({ vendor: 'moonshotai', price_status: 'unpriced_public' });
  });

  it('api family detection covers the shapes that exist in the account', () => {
    const mk = (op: string, modelId: string, ib: unknown): RawRecord => ({ timestamp: NOW, requestId: 'r', operation: op, modelId, input: { inputBodyJson: ib } });
    expect(apiFamilyOf(mk('ConverseStream', 'global.anthropic.claude-sonnet-5-5', { messages: [] }))).toBe('converse');
    expect(apiFamilyOf(mk('InvokeModel', 'anthropic.claude-haiku-4-5-20251001-v1:0', { anthropic_version: 'x', messages: [] }))).toBe('invoke');
    expect(apiFamilyOf(mk('InvokeModelWithResponseStream', 'us.openai.gpt-6-luna', { model: 'us.openai.gpt-6-luna', input: [{ type: 'message' }] }))).toBe('openai_responses');
    expect(apiFamilyOf(mk('InvokeModelWithResponseStream', 'us.openai.gpt-6-luna', { model: 'us.openai.gpt-6-luna', input: 'plain string' }))).toBe('openai_responses');
    expect(apiFamilyOf(mk('InvokeModel', 'openai.gpt-oss-120b-1:0', { messages: [{ role: 'user', content: 'hi' }] }))).toBe('openai_chat');
    expect(apiFamilyOf(mk('InvokeModel', 'amazon.titan-embed-text-v2:0', { inputText: 'x' }))).toBe('embeddings');
    expect(apiFamilyOf(mk('InvokeModel', 'stability.sd3-5-large-v1:0', { prompt: 'x' }))).toBe('image');
  });
});

describe('OTel GenAI span → silver row', () => {
  const span = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'span-otlp-genai.json'), 'utf8'));
  it('reads gen_ai.* and the request id, source otel, service as tenant', () => {
    const built = buildSilverRowFromSpan(span, { ingestTs: NOW })!;
    expect(built.row).toMatchObject({ source: 'otel', token_source: 'otel', input_tokens: 1200, output_tokens: 340, model_key: 'anthropic.claude-opus-5-5', vendor: 'anthropic', route: 'us', request_id: '0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0', service_name: 'llm-trusted-gateway', tenant_key: 'service/llm-trusted-gateway', caller_type: 'service', operation: 'chat', latency_ms: 3500, trace_id: '4bf92f3577b34da6a3ce929d0e0e4736' });
    expect(validate(stripNulls(built.row as unknown as Record<string, unknown>))).toBe(true);
  });
  it('accepts the older gen_ai.system attribute and a non-Bedrock provider', () => {
    const s2 = { ...span, attributes: [{ key: 'gen_ai.system', value: { stringValue: 'openai' } }, { key: 'gen_ai.request.model', value: { stringValue: 'gpt-4o' } }, { key: 'gen_ai.usage.input_tokens', value: { intValue: '3' } }] };
    const built = buildSilverRowFromSpan(s2, { ingestTs: NOW })!;
    expect(built.row).toMatchObject({ vendor: 'openai', model_id_raw: 'gpt-4o', input_tokens: 3, output_tokens: 0, request_id: span.spanId });
  });
});

describe('adapters never throw', () => {
  const families = ['invoke', 'converse', 'openai_responses', 'openai_chat', 'embeddings', 'image', 'other'] as const;
  const vendors = ['anthropic', 'openai', 'meta', 'mistral', 'cohere', 'ai21', 'amazon', 'deepseek', 'unknown', ''];
  it('any JSON value as request or response body yields an object, for every (vendor, family)', () => {
    fc.assert(fc.property(fc.constantFrom(...vendors), fc.constantFrom(...families), fc.jsonValue(), fc.jsonValue(), (v, f, req, res) => {
      const out = adapt(v, f, req, res);
      return !!out && typeof out === 'object';
    }), { numRuns: 400 });
  });
  it('adversarial bodies (deep, huge numbers, wrong types) still produce a valid silver row', () => {
    fc.assert(fc.property(fc.constantFrom(...vendors), fc.constantFrom(...families), fc.jsonValue({ maxDepth: 6 }), fc.jsonValue({ maxDepth: 6 }), (v, f, req, res) => {
      const rec: RawRecord = { timestamp: NOW, requestId: 'r', operation: f === 'converse' ? 'Converse' : 'InvokeModel', modelId: `${v}.model-x`, input: { inputTokenCount: 1, inputBodyJson: req }, output: { outputTokenCount: 2, outputBodyJson: res } };
      const { row } = buildSilverRow(rec, { ingestTs: NOW });
      return row.input_tokens === 1 && row.output_tokens === 2 && validate(stripNulls(row as unknown as Record<string, unknown>)) === true;
    }), { numRuns: 300 });
  });
  it('every known vendor resolves to a non-generic adapter for its native family, converse is vendor-neutral', () => {
    expect(adapterFor('anthropic', 'invoke')).not.toBe(adapterFor('zzz', 'invoke'));
    expect(adapterFor('meta', 'converse')).toBe(adapterFor('anthropic', 'converse'));
    expect(adapterFor('amazon', 'embeddings')).not.toBe(adapterFor('amazon', 'invoke'));
  });
});
