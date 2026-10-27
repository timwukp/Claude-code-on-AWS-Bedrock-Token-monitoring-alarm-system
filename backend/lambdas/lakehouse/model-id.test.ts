import { parseModelId, ParsedModelId } from './model-id';

const ACCT = '123456789012';
const arn = (kind: string, id: string, svc = 'bedrock') => `arn:aws:${svc}:us-east-1:${ACCT}:${kind}/${id}`;

type Exp = Partial<ParsedModelId>;
// Every id spelling this account has produced (cost-calc.ts, research docs, qa findings) plus the
// vendor prefixes Bedrock offers. One table so a new vendor is one more row, not a new test.
const CASES: Array<[string, Exp]> = [
  // --- Anthropic, every route spelling ---
  ['anthropic.claude-opus-5-5', { vendor: 'anthropic', family: 'claude-opus', version: '5.5', route: 'direct', modelKey: 'anthropic.claude-opus-5-5', modality: 'text' }],
  ['us.anthropic.claude-opus-5-5', { vendor: 'anthropic', family: 'claude-opus', version: '5.5', route: 'us', modelKey: 'anthropic.claude-opus-5-5' }],
  ['global.anthropic.claude-opus-5-5', { route: 'global', modelKey: 'anthropic.claude-opus-5-5' }],
  ['eu.anthropic.claude-opus-4-8', { route: 'eu', family: 'claude-opus', version: '4.8' }],
  ['apac.anthropic.claude-opus-4-8', { route: 'apac', version: '4.8' }],
  ['anthropic.claude-haiku-4-5-20251001-v1:0', { family: 'claude-haiku', version: '4.5', modelKey: 'anthropic.claude-haiku-4-5-20251001-v1:0' }],
  ['us.anthropic.claude-haiku-4-5-20251001-v1:0', { route: 'us', family: 'claude-haiku', version: '4.5' }],
  ['global.anthropic.claude-fable-5-1', { family: 'claude-fable', version: '5.1', route: 'global' }],
  ['anthropic.claude-fable-5', { family: 'claude-fable', version: '5' }],
  ['global.anthropic.claude-mythos-5-1', { family: 'claude-mythos', version: '5.1', route: 'global' }],
  ['us.anthropic.claude-sonnet-5-20260801-v1:0', { family: 'claude-sonnet', version: '5', route: 'us' }],
  ['global.anthropic.claude-sonnet-5-5', { family: 'claude-sonnet', version: '5.5' }],
  ['us.anthropic.claude-sonnet-4-6', { family: 'claude-sonnet', version: '4.6' }],
  [arn('inference-profile', 'us.anthropic.claude-fable-5'), { vendor: 'anthropic', family: 'claude-fable', route: 'us', modelKey: 'anthropic.claude-fable-5', aipArn: null }],
  [arn('inference-profile', 'global.anthropic.claude-opus-5-5'), { route: 'global', modelKey: 'anthropic.claude-opus-5-5' }],
  [arn('foundation-model', 'anthropic.claude-opus-5-5'), { vendor: 'anthropic', route: 'direct', modelKey: 'anthropic.claude-opus-5-5' }],
  // --- application inference profiles: a route, not a model ---
  [arn('application-inference-profile', '5posspchaq1y'), { vendor: 'unknown', family: 'inference-profile', route: 'profile', aipArn: arn('application-inference-profile', '5posspchaq1y'), modelKey: arn('application-inference-profile', '5posspchaq1y') }],
  ['5posspchaq1y', { vendor: 'unknown', family: 'inference-profile', route: 'profile', modelKey: '5posspchaq1y' }],
  // --- OpenAI on Bedrock ---
  ['openai.gpt-5.6-luna', { vendor: 'openai', family: 'gpt-5.6', version: '5.6', route: 'direct', modality: 'text' }],
  ['us.openai.gpt-6-luna', { vendor: 'openai', family: 'gpt-6', version: '6', route: 'us', modelKey: 'openai.gpt-6-luna' }],
  ['global.openai.gpt-5.6-sol', { route: 'global', family: 'gpt-5.6' }],
  ['us.openai.gpt-5.6-terra', { family: 'gpt-5.6' }],
  ['openai.gpt-oss-120b', { vendor: 'openai', family: 'gpt-oss', version: null }],
  ['openai.gpt-oss-20b-1:0', { vendor: 'openai', family: 'gpt-oss', modelKey: 'openai.gpt-oss-20b-1:0' }],
  ['openai.gpt-5-mini', { family: 'gpt-5', version: '5' }],
  ['openai.gpt-9-nebula', { family: 'gpt-9', version: '9' }],
  // --- Amazon ---
  ['amazon.nova-micro-v1:0', { vendor: 'amazon', family: 'nova-micro', route: 'direct', modality: 'text' }],
  ['us.amazon.nova-pro-v1:0', { vendor: 'amazon', family: 'nova-pro', route: 'us' }],
  ['amazon.nova-lite-v1:0', { family: 'nova-lite' }],
  ['amazon.titan-embed-text-v2:0', { vendor: 'amazon', family: 'titan-embed', modality: 'embedding' }],
  ['amazon.titan-image-generator-v2:0', { vendor: 'amazon', family: 'titan-image', modality: 'image' }],
  ['amazon.nova-canvas-v1:0', { family: 'nova-canvas', modality: 'image' }],
  ['amazon.nova-reel-v1:1', { family: 'nova-reel', modality: 'video' }],
  ['amazon.nova-sonic-v1:0', { family: 'nova-sonic', modality: 'speech' }],
  // --- other vendors ---
  ['meta.llama3-8b-instruct-v1:0', { vendor: 'meta', family: 'llama3', route: 'direct' }],
  ['us.meta.llama4-maverick-17b-instruct-v1:0', { vendor: 'meta', family: 'llama4', route: 'us' }],
  ['mistral.ministral-3-3b-instruct', { vendor: 'mistral', family: 'ministral' }],
  ['mistral.mistral-large-2407-v1:0', { vendor: 'mistral', family: 'mistral-large' }],
  ['cohere.command-r-plus-v1:0', { vendor: 'cohere', family: 'command-r-plus' }],
  ['cohere.embed-english-v3', { vendor: 'cohere', family: 'embed', modality: 'embedding' }],
  ['ai21.jamba-1-5-large-v1:0', { vendor: 'ai21', family: 'jamba' }],
  ['us.deepseek.r1-v1:0', { vendor: 'deepseek', family: 'r1', route: 'us' }],
  ['moonshot.kimi-k2-thinking', { vendor: 'moonshot', family: 'kimi-k2' }],
  ['moonshotai.kimi-k2.5', { vendor: 'moonshotai', family: 'kimi-k2.5' }],
  ['qwen.qwen3-235b-a22b-2507-v1:0', { vendor: 'qwen', family: 'qwen3' }],
  ['stability.sd3-5-large-v1:0', { vendor: 'stability', family: 'sd3', modality: 'image' }],
  ['luma.ray-v2:0', { vendor: 'luma', family: 'ray', modality: 'video' }],
  ['writer.palmyra-x5-v1:0', { vendor: 'writer', family: 'palmyra' }],
  ['twelvelabs.pegasus-1-2-v1:0', { vendor: 'twelvelabs', family: 'pegasus', modality: 'video' }],
  // --- provisioned / custom / imported / marketplace ---
  [arn('provisioned-model', 'abc123def456'), { route: 'provisioned', vendor: 'unknown', family: 'provisioned-model', modelKey: arn('provisioned-model', 'abc123def456') }],
  [arn('custom-model', 'anthropic.claude-haiku-4-5-20251001-v1:0/MyTune'), { route: 'custom', vendor: 'anthropic', family: 'claude-haiku', modelKey: 'anthropic.claude-haiku-4-5-20251001-v1:0' }],
  [arn('imported-model', 'xyz987'), { route: 'imported', vendor: 'unknown', family: 'imported-model' }],
  [arn('endpoint', 'my-llama-endpoint', 'sagemaker'), { route: 'marketplace', vendor: 'unknown', family: 'marketplace-endpoint' }],
  [arn('marketplace', 'some-listing', 'bedrock'), { route: 'marketplace', vendor: 'unknown' }],
  // --- garbage never throws ---
  ['', { vendor: 'unknown', family: 'unknown', route: 'direct', modelKey: '' }],
  ['not-a-model', { vendor: 'unknown', family: 'unknown', modality: 'unknown' }],
  ['weird-vendor.something-v1', { vendor: 'weird-vendor', family: 'something' }],
];

describe('parseModelId', () => {
  it.each(CASES)('%s', (raw, exp) => {
    const got = parseModelId(raw);
    for (const [k, v] of Object.entries(exp)) expect({ [k]: (got as any)[k] }).toEqual({ [k]: v });
  });

  it('never throws, for any input', () => {
    for (const s of ['', ' ', '::::', 'arn:aws:bedrock:::', 'arn:aws:bedrock:us-east-1:1:inference-profile/', '\u0000', 'a'.repeat(5000)]) {
      expect(() => parseModelId(s)).not.toThrow();
    }
  });

  it('modelKey strips the route prefix but keeps the version suffix, so us./global. variants merge (same rule as cost-calc normalizeModelId + model-names canonical)', () => {
    expect(parseModelId('us.anthropic.claude-opus-5-5').modelKey).toBe(parseModelId('global.anthropic.claude-opus-5-5').modelKey);
    expect(parseModelId('us.anthropic.claude-haiku-4-5-20251001-v1:0').modelKey).toBe('anthropic.claude-haiku-4-5-20251001-v1:0');
    expect(parseModelId(arn('inference-profile', 'us.openai.gpt-6-luna')).modelKey).toBe('openai.gpt-6-luna');
  });

  it('exposes a stable vendor table that covers every vendor in the cases', () => {
    const vendors = new Set(CASES.map(([raw]) => parseModelId(raw).vendor));
    for (const v of ['anthropic', 'openai', 'amazon', 'meta', 'mistral', 'cohere', 'ai21', 'deepseek', 'moonshot', 'moonshotai', 'qwen', 'stability', 'luma', 'writer', 'twelvelabs']) {
      expect(vendors.has(v)).toBe(true);
    }
    expect(CASES.length).toBeGreaterThanOrEqual(40);
  });
});
