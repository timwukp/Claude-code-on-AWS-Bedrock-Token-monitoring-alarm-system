import { matchRate, normalizeModelId } from './cost-calc';

/**
 * Guards the resolve-at-ingest invariant (#13): a SYSTEM inference-profile ARN still carries the
 * model family (rate card matches after normalization), but an APPLICATION inference profile's
 * ARN ends in an opaque id — it can only be priced after the aggregator resolves it to the
 * underlying model. If either assumption changes, attribution/pricing logic must be revisited.
 */
describe('normalizeModelId vs inference-profile ARNs', () => {
  it('system profile ARNs normalize to a rate-card-matching id', () => {
    const id = normalizeModelId('arn:aws:bedrock:us-east-1::inference-profile/us.anthropic.claude-sonnet-4-6');
    expect(id).toBe('us.anthropic.claude-sonnet-4-6');
    expect(matchRate(id).key).toBe('sonnet');
  });
  it('application profile ARNs stay opaque and match no rate (must be resolved at ingest)', () => {
    const id = normalizeModelId('arn:aws:bedrock:us-east-1::application-inference-profile/abc123opaque');
    expect(id).toBe('abc123opaque');
    expect(matchRate(id).key).toBe('');
    expect(matchRate(id).inPerToken).toBe(0);
  });
});
