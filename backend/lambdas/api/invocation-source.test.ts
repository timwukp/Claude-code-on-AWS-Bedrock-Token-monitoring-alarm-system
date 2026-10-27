import { CURATED_SOURCE, RAW_SOURCE, invocationSource, InvocationSource } from './invocation-source';

// One module owns "which table and which column expressions" for every Athena template. P0 points
// it at the curated Parquet table; P3 will point it at silver.invocations without touching templates.
describe('invocation sources', () => {
  const sources: Array<[string, InvocationSource]> = [['raw', RAW_SOURCE], ['curated', CURATED_SOURCE]];

  it.each(sources)('%s exposes every expression a template needs', (_name, src) => {
    for (const fn of [src.inputTokens, src.outputTokens, src.cacheReadTokens, src.cacheWriteTokens, src.identityArn, src.modelId, src.timestamp]) {
      expect(fn('l')).toMatch(/l[.\w"]*/);
    }
    expect(src.meta('l', 'project_id')).toContain('project_id');
    expect(src.table).toMatch(/^[a-z_]+$/);
  });

  it('raw keeps the nested log shape (struct members, MAP lookup, no partition filter)', () => {
    expect(RAW_SOURCE.table).toBe('bedrock_invocation_logs');
    expect(RAW_SOURCE.inputTokens('l')).toBe('l.input.inputTokenCount');
    expect(RAW_SOURCE.cacheWriteTokens('l')).toBe('l.input.cacheWriteInputTokenCount');
    expect(RAW_SOURCE.outputTokens('l')).toBe('l.output.outputTokenCount');
    expect(RAW_SOURCE.identityArn('l')).toBe('l.identity.arn');
    expect(RAW_SOURCE.meta('l', 'tenant')).toBe("l.requestMetadata['tenant']");
    expect(RAW_SOURCE.recentDays('l', 30)).toBe('');
  });

  it('curated reads the flat Parquet columns, parses requestMetadata JSON, and prunes by dt', () => {
    expect(CURATED_SOURCE.table).toBe('bedrock_invocations_curated');
    expect(CURATED_SOURCE.inputTokens('l')).toBe('COALESCE(l.inputTokenCount, 0)');
    expect(CURATED_SOURCE.cacheReadTokens('l')).toBe('COALESCE(l.cacheReadInputTokenCount, 0)');
    expect(CURATED_SOURCE.outputTokens('l')).toBe('COALESCE(l.outputTokenCount, 0)');
    expect(CURATED_SOURCE.identityArn('l')).toBe('l.identityArn');
    expect(CURATED_SOURCE.meta('l', 'project_id')).toBe("json_extract_scalar(l.requestMetadata, '$.project_id')");
    expect(CURATED_SOURCE.recentDays('l', 30)).toBe("AND l.dt >= date_format(date_add('day', -30, current_date), '%Y-%m-%d')");
  });

  it('day() yields the record day: the dt partition on curated, the timestamp prefix on raw', () => {
    expect(CURATED_SOURCE.day('l')).toBe('l.dt');
    expect(RAW_SOURCE.day('l')).toBe('substr(l."timestamp", 1, 10)');
  });

  it('meta() only accepts identifier-like keys — the key is interpolated into SQL', () => {
    expect(() => CURATED_SOURCE.meta('l', "x'); DROP TABLE t; --")).toThrow();
    expect(() => RAW_SOURCE.meta('l', 'user-id')).toThrow();
  });

  it('tenantPredicate mirrors the aggregator: requestMetadata.tenant, else the caller ARN', () => {
    expect(RAW_SOURCE.tenantPredicate('l', 'arn:aws:iam::1:user/x')).toBe("COALESCE(l.requestMetadata['tenant'], l.identity.arn) = 'arn:aws:iam::1:user/x'");
    expect(CURATED_SOURCE.tenantPredicate('l', 'arn:aws:iam::1:user/x')).toBe("COALESCE(json_extract_scalar(l.requestMetadata, '$.tenant'), l.identityArn) = 'arn:aws:iam::1:user/x'");
  });

  it('is selected by INVOCATION_SOURCE and defaults to curated', () => {
    const prev = process.env.INVOCATION_SOURCE;
    delete process.env.INVOCATION_SOURCE;
    expect(invocationSource()).toBe(CURATED_SOURCE);
    process.env.INVOCATION_SOURCE = 'raw';
    expect(invocationSource()).toBe(RAW_SOURCE);
    process.env.INVOCATION_SOURCE = 'nonsense';
    expect(invocationSource()).toBe(CURATED_SOURCE);
    if (prev === undefined) delete process.env.INVOCATION_SOURCE; else process.env.INVOCATION_SOURCE = prev;
  });
});
