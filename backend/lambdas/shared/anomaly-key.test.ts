import { ANOMALY_SK_PREFIX, anomalyPk, anomalySk, targetKeys, tenantOf } from './anomaly-key';

/** A realistic tenant id: for AIP-routed traffic the tenant IS the caller ARN. The account segment
 *  is left as a name rather than digits — the repo's leak scan rejects any 12-digit run, including
 *  documentation placeholders, and nothing here depends on its shape. */
const ARN = 'arn:aws:sts::ACCOUNT_ID:assumed-role/DevRole/session-1';

describe('anomaly key shape', () => {
  const tenant = ARN;

  it('partitions by tenant with no suffix', () => {
    // The suffix is the whole bug: `TENANT#<t>#ANOMALY` is a different partition from `TENANT#<t>`,
    // so the reader's equality condition can never match it.
    expect(anomalyPk(tenant)).toBe(`TENANT#${tenant}`);
    expect(anomalyPk(tenant)).not.toContain('#ANOMALY');
  });

  it('prefixes every sort key so the reader\'s begins_with matches', () => {
    const sk = anomalySk('2026-09-18T13:27:40Z', 'AccessDenied', '203.0.113.7');
    expect(sk.startsWith(ANOMALY_SK_PREFIX)).toBe(true);
    expect(sk).toBe('ANOMALY#2026-09-18T13:27:40Z#AccessDenied#203.0.113.7');
  });

  it('sorts chronologically as a string, so ScanIndexForward:false is newest-first', () => {
    // The reader has no secondary index; it relies entirely on this ordering.
    const older = anomalySk('2026-09-18T01:00:00Z', 'ai-spend-runaway', 'req-1');
    const newer = anomalySk('2026-09-18T22:00:00Z', 'ai-spend-runaway', 'req-2');
    expect([newer, older].sort()).toEqual([older, newer]);
  });

  it('orders by time before type, so one type cannot bury another', () => {
    // Putting the type first would group by type and make the feed's ordering per-type, not global.
    const zType = anomalySk('2026-09-18T01:00:00Z', 'zzz-late-alphabetically', 'x');
    const aType = anomalySk('2026-09-18T02:00:00Z', 'aaa-early-alphabetically', 'x');
    expect([aType, zType].sort()).toEqual([zType, aType]);
  });

  it('is deterministic, so a re-processed batch re-puts rather than duplicates', () => {
    const args = ['2026-09-18T13:27:40Z', 'ai-spend-runaway', 'req-abc'] as const;
    expect(anomalySk(...args)).toBe(anomalySk(...args));
  });

  it('keeps two anomalies distinct via the discriminator', () => {
    const a = anomalySk('2026-09-18T13:27:40Z', 'ai-spend-runaway', 'req-1');
    const b = anomalySk('2026-09-18T13:27:40Z', 'ai-spend-runaway', 'req-2');
    expect(a).not.toBe(b);
  });

  it('produces a key the reader\'s own condition would return', () => {
    // Re-states api/anomalies.ts's KeyConditionExpression as an executable assertion: this is the
    // check whose absence let the two sides drift.
    const pk = anomalyPk(tenant);
    const sk = anomalySk('2026-09-18T13:27:40Z', 'ContainmentFailed', 'n/a');
    expect(pk === `TENANT#${tenant}` && sk.startsWith('ANOMALY#')).toBe(true);
  });
});

describe('tenantOf (legacy shape)', () => {
  it('strips the legacy #ANOMALY suffix', () => {
    expect(tenantOf(`TENANT#${ARN}#ANOMALY`)).toBe(ARN);
  });

  it('leaves a conforming partition key alone', () => {
    expect(tenantOf(`TENANT#${ARN}`)).toBe(ARN);
  });

  it('returns null for a partition that is not an anomaly partition', () => {
    // The table is shared, so the scan sees other item types; rewriting one would corrupt it.
    expect(tenantOf('SYSTEM#WATERMARK')).toBeNull();
    expect(tenantOf('REGISTRY#META')).toBeNull();
  });
});

describe('targetKeys (legacy shape)', () => {
  it('rewrites both halves of the legacy shape', () => {
    const to = targetKeys({
      pk: `TENANT#${ARN}#ANOMALY`,
      sk: '2026-09-18T13:27:40Z#AccessDenied#203.0.113.7',
      detectedAt: '2026-09-18T13:27:40Z',
      type: 'AccessDenied',
      sourceIp: '203.0.113.7',
    });
    expect(to).toEqual({
      pk: `TENANT#${ARN}`,
      sk: 'ANOMALY#2026-09-18T13:27:40Z#AccessDenied#203.0.113.7',
    });
  });

  it('returns null for an item already readable, so a re-run is a no-op', () => {
    expect(targetKeys({
      pk: `TENANT#${ARN}`,
      sk: 'ANOMALY#2026-09-18T13:27:40Z#ai-spend-runaway#req-1',
    })).toBeNull();
  });

  it('fixes a bare sort key even when the partition key was already right', () => {
    // The two halves drifted independently, so one being correct does not imply the other is.
    expect(targetKeys({
      pk: `TENANT#${ARN}`,
      sk: '2026-09-18T13:27:40Z#OffHoursUsage#n/a',
      detectedAt: '2026-09-18T13:27:40Z',
      type: 'OffHoursUsage',
      sourceIp: 'n/a',
    })?.sk).toBe('ANOMALY#2026-09-18T13:27:40Z#OffHoursUsage#n/a');
  });

  it('prefers the stored attributes over re-parsing the sort key', () => {
    // A sourceIp is not guaranteed '#'-free, and splitting on '#' would truncate it. The attributes
    // are also what the page renders, so they are the authoritative copy.
    const to = targetKeys({
      pk: `TENANT#${ARN}#ANOMALY`,
      sk: '2026-09-18T13:27:40Z#AccessDenied#weird#ip#value',
      detectedAt: '2026-09-18T13:27:40Z',
      type: 'AccessDenied',
      sourceIp: 'weird#ip#value',
    });
    expect(to?.sk).toBe('ANOMALY#2026-09-18T13:27:40Z#AccessDenied#weird#ip#value');
  });

  it('falls back to the sort key when the attributes are missing', () => {
    const to = targetKeys({
      pk: `TENANT#${ARN}#ANOMALY`,
      sk: '2026-09-18T13:27:40Z#ContainmentFailed#n/a',
    });
    expect(to?.sk).toBe('ANOMALY#2026-09-18T13:27:40Z#ContainmentFailed#n/a');
  });

  it('never rewrites a non-anomaly item', () => {
    expect(targetKeys({ pk: 'SYSTEM#WATERMARK', sk: 'aggregator' })).toBeNull();
  });
});
