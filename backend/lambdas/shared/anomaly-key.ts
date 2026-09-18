/**
 * The anomalies table's key shape — one definition for every writer and its only reader.
 *
 * This exists because the shape had already drifted: `anomaly-response` wrote
 * `pk = TENANT#<t>#ANOMALY` with a bare `<eventTime>#<type>#<sourceIp>` sort key, while
 * `api/anomalies.ts` queries `pk = TENANT#<t>` with `begins_with(sk, 'ANOMALY#')`. Both halves were
 * wrong, so every item that Lambda wrote was unreachable — a security alert silently absent from the
 * feed that exists to show it. DynamoDB cannot catch that: a Put with the wrong key succeeds, and the
 * mismatched Query just returns nothing. Only a shared definition can.
 *
 * A partition per tenant with a prefixed sort key keeps the feed a single-partition query, and
 * because `detectedAt` leads the sort key the reader's `ScanIndexForward: false` yields newest-first
 * without a secondary index.
 */

/** Sort-key prefix the reader filters on. Every anomaly sort key must start with it. */
export const ANOMALY_SK_PREFIX = 'ANOMALY#';

/** Partition key: one partition per tenant. `tenantId` is the caller ARN for AIP-routed traffic. */
export const anomalyPk = (tenantId: string): string => `TENANT#${tenantId}`;

/**
 * Sort key: `ANOMALY#<detectedAt>#<type>#<discriminator>`.
 *
 * `detectedAt` leads so the range sorts chronologically. The discriminator is whatever makes two
 * anomalies of the same type at the same instant distinct — a request id, a source IP. Keep it
 * deterministic: an identical input must produce an identical key, so re-processing a batch re-puts
 * the same item instead of duplicating the alert.
 */
export const anomalySk = (detectedAt: string, type: string, discriminator: string): string =>
  `${ANOMALY_SK_PREFIX}${detectedAt}#${type}#${discriminator}`;

// ---- Repairing the legacy shape ----
// Items written before this module existed are still in the table and still unreadable. Recognising
// and rewriting them is key-shape knowledge, so it lives here rather than in the migration script.

/** The suffix the legacy writer appended to the partition key. */
const LEGACY_PK_SUFFIX = '#ANOMALY';

/** Any item as scanned from the table — the anomalies table also holds non-anomaly partitions. */
export interface AnomalyTableItem {
  pk: string;
  sk: string;
  [attribute: string]: unknown;
}

/** Recover the tenant from either key shape. Null when the pk is not an anomaly partition at all. */
export function tenantOf(pk: string): string | null {
  if (!pk.startsWith('TENANT#')) return null;
  const rest = pk.slice('TENANT#'.length);
  return rest.endsWith(LEGACY_PK_SUFFIX) ? rest.slice(0, -LEGACY_PK_SUFFIX.length) : rest;
}

/**
 * The corrected keys for one item, or null when it already conforms (or is not an anomaly).
 *
 * The legacy sort key is `<detectedAt>#<type>#<discriminator>`, but `detectedAt` and `type` are also
 * stored as attributes, so those are preferred over re-parsing the string: a sourceIp is not
 * guaranteed '#'-free, and the attributes are what the page renders anyway.
 *
 * The two halves drifted independently, so a correct pk does not imply a correct sk — both are
 * checked.
 */
export function targetKeys(item: AnomalyTableItem): { pk: string; sk: string } | null {
  const tenant = tenantOf(item.pk);
  if (tenant === null) return null;
  if (item.pk === anomalyPk(tenant) && item.sk.startsWith(ANOMALY_SK_PREFIX)) return null;

  const parts = item.sk.split('#');
  const detectedAt = (item.detectedAt as string | undefined) ?? parts[0] ?? '';
  const type = (item.type as string | undefined) ?? parts[1] ?? 'unknown';
  const discriminator = (item.sourceIp as string | undefined) ?? parts.slice(2).join('#') ?? 'n/a';
  return { pk: anomalyPk(tenant), sk: anomalySk(detectedAt, type, discriminator) };
}
