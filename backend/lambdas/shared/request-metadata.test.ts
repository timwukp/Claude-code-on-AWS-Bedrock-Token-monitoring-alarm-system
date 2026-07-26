import {
  buildRequestMetadata,
  withRequestMetadata,
  MetadataValidationError,
  MAX_VALUE_LENGTH,
  RECOMMENDED_MAX_VALUE_LENGTH,
  MAX_PAIRS,
} from './request-metadata';

const VALID = { tenant: 'acme', project_id: 'proj-bravo', user_id: 'u-2001' };

describe('buildRequestMetadata — valid input', () => {
  it('builds the map from required fields with no warnings', () => {
    const { metadata, warnings } = buildRequestMetadata(VALID);
    expect(metadata).toEqual({ tenant: 'acme', project_id: 'proj-bravo', user_id: 'u-2001' });
    expect(warnings).toHaveLength(0);
  });

  it('merges optional tags alongside the required fields', () => {
    const { metadata } = buildRequestMetadata({ ...VALID, tags: { team: 'fraud', env: 'prod' } });
    expect(metadata).toMatchObject({ team: 'fraud', env: 'prod', project_id: 'proj-bravo' });
  });
});

describe('buildRequestMetadata — required fields', () => {
  it.each(['tenant', 'project_id', 'user_id'])('throws when %s is missing', (field) => {
    const input: Record<string, string> = { ...VALID };
    delete input[field];
    expect(() => buildRequestMetadata(input as never)).toThrow(MetadataValidationError);
  });

  it('throws when a required field is empty after sanitization', () => {
    expect(() => buildRequestMetadata({ ...VALID, user_id: '   ' })).toThrow(/empty/i);
  });

  it('throws when input is not an object', () => {
    expect(() => buildRequestMetadata(null as never)).toThrow(MetadataValidationError);
  });
});

describe('buildRequestMetadata — PII rejection', () => {
  it('rejects an email-like user_id and recommends an opaque id', () => {
    expect(() => buildRequestMetadata({ ...VALID, user_id: 'alice@example.com' })).toThrow(/email|opaque/i);
  });

  it('rejects an email in an optional tag too', () => {
    expect(() => buildRequestMetadata({ ...VALID, tags: { owner: 'bob@corp.io' } })).toThrow(
      MetadataValidationError,
    );
  });

  it('accepts a non-email opaque id', () => {
    expect(() => buildRequestMetadata({ ...VALID, user_id: 'u-2001' })).not.toThrow();
  });
});

describe('buildRequestMetadata — sanitization & limits', () => {
  it('strips control characters and warns', () => {
    const { metadata, warnings } = buildRequestMetadata({ ...VALID, user_id: 'u-2001\u0007\t' });
    expect(metadata.user_id).toBe('u-2001');
    expect(warnings.find((w) => w.key === 'user_id')).toBeTruthy();
  });

  it('truncates over-long values to the hard cap and warns', () => {
    const long = 'p'.repeat(MAX_VALUE_LENGTH + 50);
    const { metadata, warnings } = buildRequestMetadata({ ...VALID, project_id: long });
    expect(metadata.project_id).toHaveLength(MAX_VALUE_LENGTH);
    expect(warnings.find((w) => w.key === 'project_id' && /truncat/i.test(w.message))).toBeTruthy();
  });

  it('warns (but does not fail) when a value exceeds the recommended length', () => {
    const value = 'p'.repeat(RECOMMENDED_MAX_VALUE_LENGTH + 5);
    const { warnings } = buildRequestMetadata({ ...VALID, project_id: value });
    expect(warnings.find((w) => /recommended/i.test(w.message))).toBeTruthy();
  });

  it('throws on unsupported key characters', () => {
    expect(() => buildRequestMetadata({ ...VALID, tags: { 'bad key!': 'x' } })).toThrow(/unsupported/i);
  });

  it('throws on a non-string value', () => {
    expect(() => buildRequestMetadata({ ...VALID, tags: { n: 5 as never } })).toThrow(/must be a string/i);
  });

  it('throws when there are too many pairs', () => {
    const tags: Record<string, string> = {};
    for (let i = 0; i < MAX_PAIRS; i++) tags[`k${i}`] = 'v';
    expect(() => buildRequestMetadata({ ...VALID, tags })).toThrow(/Too many/i);
  });
});

describe('withRequestMetadata — wrapper', () => {
  it('injects requestMetadata into a plain Bedrock request input', () => {
    const base = { modelId: 'anthropic.claude-opus-4-8', body: '{}' };
    const { input } = withRequestMetadata(base, VALID);
    expect(input.requestMetadata).toEqual({ tenant: 'acme', project_id: 'proj-bravo', user_id: 'u-2001' });
    expect(input.modelId).toBe('anthropic.claude-opus-4-8');
  });

  it('does not mutate the caller’s original request object', () => {
    const base: Record<string, unknown> = { modelId: 'm' };
    withRequestMetadata(base, VALID);
    expect(base.requestMetadata).toBeUndefined();
  });

  it('built tags override existing requestMetadata by default', () => {
    const base = { requestMetadata: { project_id: 'stale', other: 'keep' } };
    const { input } = withRequestMetadata(base, VALID);
    expect(input.requestMetadata?.project_id).toBe('proj-bravo');
  });

  it('preserves existing values when overrideExisting is false', () => {
    const base = { requestMetadata: { project_id: 'keep-me' } };
    const { input } = withRequestMetadata(base, VALID, { overrideExisting: false });
    expect(input.requestMetadata?.project_id).toBe('keep-me');
  });

  it('propagates validation errors from the builder', () => {
    expect(() => withRequestMetadata({}, { ...VALID, user_id: 'a@b.com' })).toThrow(MetadataValidationError);
  });
});
