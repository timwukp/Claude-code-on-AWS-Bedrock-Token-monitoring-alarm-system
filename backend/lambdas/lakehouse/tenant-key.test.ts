import { tenantKeyOf } from './tenant-key';

const A = '123456789012';

describe('tenantKeyOf', () => {
  it('a requestMetadata.tenant tag wins over the caller identity', () => {
    expect(tenantKeyOf(`arn:aws:iam::${A}:user/timwu`, 'team-a')).toEqual({ tenantKey: 'team-a', callerType: 'user' });
  });

  it('IAM users are their own tenant; Bedrock API-key users are flagged as such', () => {
    expect(tenantKeyOf(`arn:aws:iam::${A}:user/timwu`)).toEqual({ tenantKey: `arn:aws:iam::${A}:user/timwu`, callerType: 'user' });
    expect(tenantKeyOf(`arn:aws:iam::${A}:user/BedrockAPIKey-yq3t`)).toEqual({ tenantKey: `arn:aws:iam::${A}:user/BedrockAPIKey-yq3t`, callerType: 'api_key_user' });
  });

  it('assumed-role sessions collapse to the role — the 2,524-tenant explosion came from one key per session', () => {
    const sessions = Array.from({ length: 50 }, (_, i) => `arn:aws:sts::${A}:assumed-role/AgentCore-uitestagent-def-ApplicationAgentUitestage-mzobm0YQRR1k/BedrockAgentCore-${i}`);
    const keys = new Set(sessions.map((s) => tenantKeyOf(s).tenantKey));
    expect(keys).toEqual(new Set([`arn:aws:iam::${A}:role/AgentCore-uitestagent-def-ApplicationAgentUitestage-mzobm0YQRR1k`]));
    expect(tenantKeyOf(sessions[0]).callerType).toBe('role');
  });

  it('keeps role paths and already-canonical role ARNs', () => {
    expect(tenantKeyOf(`arn:aws:iam::${A}:role/llmops-harness-execution`)).toEqual({ tenantKey: `arn:aws:iam::${A}:role/llmops-harness-execution`, callerType: 'role' });
    expect(tenantKeyOf(`arn:aws:sts::${A}:assumed-role/service-role/MyRole/sess`)).toEqual({ tenantKey: `arn:aws:iam::${A}:role/service-role/MyRole`, callerType: 'role' });
  });

  it('service principals and anything unparseable keep the raw value and say so', () => {
    expect(tenantKeyOf('bedrock.amazonaws.com')).toEqual({ tenantKey: 'bedrock.amazonaws.com', callerType: 'service' });
    expect(tenantKeyOf(`arn:aws:iam::${A}:root`)).toEqual({ tenantKey: `arn:aws:iam::${A}:root`, callerType: 'user' });
    expect(tenantKeyOf('garbage')).toEqual({ tenantKey: 'garbage', callerType: 'unknown' });
    expect(tenantKeyOf(undefined)).toEqual({ tenantKey: 'unknown', callerType: 'unknown' });
    expect(tenantKeyOf('')).toEqual({ tenantKey: 'unknown', callerType: 'unknown' });
  });

  it('lower-cases nothing: ARNs are case-sensitive and the registry matches them exactly', () => {
    expect(tenantKeyOf(`arn:aws:sts::${A}:assumed-role/MixedCase/x`).tenantKey).toBe(`arn:aws:iam::${A}:role/MixedCase`);
  });
});
