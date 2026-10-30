import { buildDimModel, dimModelStatements } from './dim-model-refresh';

const NOW = '2026-10-30T01:00:00.000Z';
const FM = [
  { modelId: 'anthropic.claude-opus-5-5', providerName: 'Anthropic', inputModalities: ['TEXT', 'IMAGE'], outputModalities: ['TEXT'], modelLifecycle: { status: 'ACTIVE' } },
  { modelId: 'amazon.titan-embed-text-v2:0', providerName: 'Amazon', inputModalities: ['TEXT'], outputModalities: ['EMBEDDING'], modelLifecycle: { status: 'ACTIVE' } },
  { modelId: 'moonshotai.kimi-k2.5', providerName: 'Moonshot', inputModalities: ['TEXT'], outputModalities: ['TEXT'], modelLifecycle: { status: 'ACTIVE' } },
  { modelId: 'stability.sd3-5-large-v1:0', providerName: 'Stability AI', inputModalities: ['TEXT'], outputModalities: ['IMAGE'], modelLifecycle: { status: 'LEGACY' } },
];
const PROFILES = [
  { inferenceProfileId: 'us.anthropic.claude-opus-5-5', inferenceProfileArn: 'arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.anthropic.claude-opus-5-5', type: 'SYSTEM_DEFINED', models: [{ modelArn: 'arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-opus-5-5' }] },
  { inferenceProfileArn: 'arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/abc123', type: 'APPLICATION', models: [{ modelArn: 'arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-opus-5-5' }] },
];
const PROV = [{ provisionedModelArn: 'arn:aws:bedrock:us-east-1:123456789012:provisioned-model/pm-1', modelArn: 'arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-opus-5-5', status: 'InService' }];
const CUSTOM = [{ modelArn: 'arn:aws:bedrock:us-east-1:123456789012:custom-model/anthropic.claude-haiku/xyz' }];
const IMPORTED = [{ modelArn: 'arn:aws:bedrock:us-east-1:123456789012:imported-model/im-9' }];

describe('buildDimModel', () => {
  const rows = buildDimModel(FM, PROFILES, PROV, CUSTOM, IMPORTED, NOW);

  it('one row per model key, sorted, with vendor/family/modality and the lifecycle from the API', () => {
    const opus = rows.find((r) => r.model_key === 'anthropic.claude-opus-5-5')!;
    expect(opus).toMatchObject({ vendor: 'anthropic', modality: 'text', lifecycle: 'ACTIVE', price_status: 'priced', refreshed_at: NOW });
    expect(JSON.parse(opus.input_modalities!)).toEqual(['TEXT', 'IMAGE']);
    expect(rows.map((r) => r.model_key)).toEqual([...rows.map((r) => r.model_key)].sort());
    expect(new Set(rows.map((r) => r.model_key)).size).toBe(rows.length);
  });

  it('price_status: priced when the rate card has a row, unpriced_public for a public model it lacks, unpriced_private for custom/imported/provisioned', () => {
    expect(rows.find((r) => r.model_key === 'moonshotai.kimi-k2.5')!.price_status).toBe('unpriced_public');
    expect(rows.find((r) => r.model_key === 'amazon.titan-embed-text-v2:0')).toMatchObject({ modality: 'embedding' });
    expect(rows.find((r) => /provisioned-model/.test(r.model_key))).toMatchObject({ price_status: 'unpriced_private', vendor: 'anthropic', lifecycle: 'InService' });
    expect(rows.find((r) => r.model_key === 'anthropic.claude-haiku')).toMatchObject({ price_status: 'unpriced_private', vendor: 'anthropic' }); // custom model: key from its base id
    expect(rows.find((r) => /imported-model/.test(r.model_key))!.price_status).toBe('unpriced_private');
  });

  it('system cross-region profiles collapse onto their foundation model; application profiles keep their own row', () => {
    expect(rows.filter((r) => r.model_key === 'anthropic.claude-opus-5-5')).toHaveLength(1);
    const aip = rows.find((r) => /application-inference-profile/.test(r.model_key))!;
    expect(aip).toMatchObject({ vendor: 'anthropic', modality: 'text', lifecycle: 'ACTIVE' });
  });

  it('writes a DELETE then chunked INSERT … VALUES with every string quoted', () => {
    const many = buildDimModel(Array.from({ length: 450 }, (_, i) => ({ modelId: `vendorx.model-${i}`, inputModalities: ['TEXT'], outputModalities: ['TEXT'] })), [], [], [], [], NOW);
    const stmts = dimModelStatements('tums-lakehouse-dev', many);
    expect(stmts[0]).toBe('DELETE FROM "s3tablescatalog/tums-lakehouse-dev"."silver"."dim_model"');
    expect(stmts).toHaveLength(1 + Math.ceil(450 / 200));
    expect(stmts[1]).toMatch(/^INSERT INTO "s3tablescatalog\/tums-lakehouse-dev"\."silver"\."dim_model" \(model_key, vendor/);
    const evil = buildDimModel([{ modelId: "vendor.x'); DROP TABLE y; --" }], [], [], [], [], NOW);
    expect(dimModelStatements('b', evil)[1]).toContain("'vendor.x''); DROP TABLE y; --'");
  });
});
