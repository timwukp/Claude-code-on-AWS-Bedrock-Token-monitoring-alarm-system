/**
 * Where the Athena templates read invocations from, and how each field is spelled there.
 *
 * `raw` is the Glue table over Bedrock's own delivery prefix (nested structs, a MAP for
 * requestMetadata, and — fatally — the `data/` body objects inside the same prefix: qa F-PR75-001).
 * `curated` is the flat Parquet the ETL writes under `usage/dt=YYYY-MM-DD/`, which contains only
 * records the ETL parsed, so a foreign body shape can never fail a query, and `dt` prunes the scan.
 */
export interface InvocationSource {
  readonly name: 'raw' | 'curated';
  readonly table: string;
  inputTokens(alias: string): string;
  outputTokens(alias: string): string;
  cacheReadTokens(alias: string): string;
  cacheWriteTokens(alias: string): string;
  identityArn(alias: string): string;
  modelId(alias: string): string;
  /** ISO-8601 record time as an Athena TIMESTAMP. */
  timestamp(alias: string): string;
  /** `requestMetadata[key]`; `key` is interpolated, so it must be identifier-like. */
  meta(alias: string, key: string): string;
  /** `COALESCE(requestMetadata.tenant, identity.arn) = '<sanitised tenant>'` — the aggregator's rule. */
  tenantPredicate(alias: string, sanitizedTenant: string): string;
  /** Partition predicate (prefixed with AND) limiting the scan to the last N days; '' when unsupported. */
  recentDays(alias: string, days: number): string;
}

const META_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
function assertKey(key: string): string {
  if (!META_KEY.test(key)) throw new Error(`requestMetadata key is not identifier-like: ${key}`);
  return key;
}

export const RAW_SOURCE: InvocationSource = {
  name: 'raw',
  table: 'bedrock_invocation_logs',
  inputTokens: (a) => `${a}.input.inputTokenCount`,
  outputTokens: (a) => `${a}.output.outputTokenCount`,
  cacheReadTokens: (a) => `${a}.input.cacheReadInputTokenCount`,
  cacheWriteTokens: (a) => `${a}.input.cacheWriteInputTokenCount`,
  identityArn: (a) => `${a}.identity.arn`,
  modelId: (a) => `${a}.modelId`,
  timestamp: (a) => `from_iso8601_timestamp(${a}."timestamp")`,
  meta: (a, key) => `${a}.requestMetadata['${assertKey(key)}']`,
  tenantPredicate: (a, t) => `COALESCE(${a}.requestMetadata['tenant'], ${a}.identity.arn) = '${t}'`,
  recentDays: () => '',
};

export const CURATED_SOURCE: InvocationSource = {
  name: 'curated',
  table: 'bedrock_invocations_curated',
  inputTokens: (a) => `COALESCE(${a}.inputTokenCount, 0)`,
  outputTokens: (a) => `COALESCE(${a}.outputTokenCount, 0)`,
  cacheReadTokens: (a) => `COALESCE(${a}.cacheReadInputTokenCount, 0)`,
  cacheWriteTokens: (a) => `COALESCE(${a}.cacheWriteInputTokenCount, 0)`,
  identityArn: (a) => `${a}.identityArn`,
  modelId: (a) => `${a}.modelId`,
  timestamp: (a) => `from_iso8601_timestamp(${a}."timestamp")`,
  meta: (a, key) => `json_extract_scalar(${a}.requestMetadata, '$.${assertKey(key)}')`,
  tenantPredicate: (a, t) => `COALESCE(json_extract_scalar(${a}.requestMetadata, '$.tenant'), ${a}.identityArn) = '${t}'`,
  recentDays: (a, days) => `AND ${a}.dt >= date_format(date_add('day', -${Math.floor(days)}, current_date), '%Y-%m-%d')`,
};

export function invocationSource(): InvocationSource {
  return process.env.INVOCATION_SOURCE === 'raw' ? RAW_SOURCE : CURATED_SOURCE;
}
