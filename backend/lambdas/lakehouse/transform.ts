/**
 * Firehose data-transformation Lambda for the bronze layer.
 *
 * Every Firehose record becomes exactly one bronze row routed by `metadata.otfMetadata` to its
 * Iceberg table. The destination accepts ONE JSON object per record ("You can send only one JSON
 * object in one Firehose record. If you aggregate and send multiple JSON objects inside a record,
 * Firehose throws an error and delivers data to the S3 error bucket" — Apache Iceberg destination,
 * Considerations and limitations). So:
 *  - Iceberg destinations accept only the Lambda processor, so a CloudWatch Logs record arrives as the
 *    gzip'd envelope with N events (bounded at 64 MiB on inflate); every event yields its bronze row
 *    AND, for Bedrock records and GenAI spans, a silver.invocations row (plus silver.adapter_audit rows
 *    when a vendor adapter disagreed with the envelope — see canonical.ts);
 *  - the FIRST row answers the recordId and the rest are re-ingested into the same stream with
 *    `firehose:PutRecordBatch`, pre-routed as `{ "__tums_table": "<db>.<table>", "row": {...} }`, which
 *    this Lambda passes straight through — but only to tables the spec knows (bronze or silver); any
 *    other name is ProcessingFailed, never routed;
 *  - if re-ingest is impossible (no STREAM_NAME, or PutRecordBatch fails) the record is returned as
 *    ProcessingFailed so the original payload lands in the error prefix — never silently lost.
 * A record that cannot be parsed at all is ProcessingFailed; a record that is recognisably not data
 * (CloudWatch CONTROL_MESSAGE, permission-check marker) is Dropped. This module never throws.
 */
import { gunzipSync } from 'zlib';
import { FirehoseClient, PutRecordBatchCommand } from '@aws-sdk/client-firehose';
import { BronzeBedrockInvocationsRow } from './generated/row-types';
import { isMetricDatapoint, parseMetricStreamRecord } from './metric-stream';
import { isSpan, parseSpanRecord } from './otel-span';
import { buildSilverRow, buildSilverRowFromSpan, isGenAiSpan, RawRecord } from './canonical';
import { AttributionMaps } from '../ingestion/parse';
import tablesJson from '../../../spec/lakehouse/generated/tables.json';

export interface TransformEnv {
  BRONZE_DATABASE: string;
  TABLE_INVOCATIONS: string;
  TABLE_SPANS: string;
  TABLE_METRICS: string;
  SILVER_DATABASE: string;
  TABLE_SILVER_INVOCATIONS: string;
  TABLE_ADAPTER_AUDIT: string;
  BEDROCK_LOG_GROUP?: string;
  SPANS_LOG_GROUP?: string;
  STREAM_NAME?: string;
  /** Registry snapshot for best-effort attribution; absent → attribution_source 'none'. */
  maps?: AttributionMaps;
}

/** Inflating a CloudWatch Logs envelope is bounded so a hostile or corrupt record cannot exhaust the Lambda. */
export const MAX_INFLATED_BYTES = 64 * 1024 * 1024;

/** `<database>.<table>` names a re-ingested row may be routed to: exactly the spec's bronze and silver tables. */
export const ROUTABLE_TABLES: ReadonlySet<string> = new Set(
  (tablesJson as { tables: Array<{ layer: string; table: string; storage: string }> }).tables
    .filter((t) => (t.layer === 'bronze' || t.layer === 'silver') && t.storage === 's3tables')
    .map((t) => `${t.layer}.${t.table}`),
);

export interface FirehoseInputRecord { recordId: string; data: string; approximateArrivalTimestamp?: number }

export interface FirehoseOutputRecord {
  recordId: string;
  result: 'Ok' | 'Dropped' | 'ProcessingFailed';
  data: string;
  metadata?: { otfMetadata: { destinationDatabaseName: string; destinationTableName: string; operation: 'insert' } };
}

/** `database` is the Iceberg namespace (bronze | silver). */
export interface RoutedRow { database: string; table: string; row: Record<string, unknown> }

export interface TransformResult {
  output: FirehoseOutputRecord;
  /** Rows beyond the first, to be re-ingested (empty on the normal one-in-one-out path). */
  overflow: RoutedRow[];
}

const REINGEST_MARKER = '__tums_table';

interface CwlPayload { messageType?: string; logGroup?: string; logEvents?: Array<{ id?: string; timestamp?: number; message?: string }> }

/** null = not gzip; 'too-large' = gzip but inflates past MAX_INFLATED_BYTES (→ ProcessingFailed). */
function tryGunzip(buf: Buffer): string | null | 'too-large' {
  if (buf.length < 2 || buf[0] !== 0x1f || buf[1] !== 0x8b) return null;
  try { return gunzipSync(buf, { maxOutputLength: MAX_INFLATED_BYTES }).toString('utf8'); } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (err instanceof RangeError || code === 'ERR_BUFFER_TOO_LARGE') return 'too-large';
    return null;
  }
}

function tryJson(text: string): unknown {
  try { return JSON.parse(text); } catch { return undefined; }
}

export function invocationRow(rec: Record<string, any>, rawText: string, ingestTs: string): BronzeBedrockInvocationsRow | null {
  const ts = typeof rec.timestamp === 'string' ? rec.timestamp : null;
  const requestId = typeof rec.requestId === 'string' ? rec.requestId : null;
  if (!ts || !requestId) return null;
  const iso = new Date(ts).toISOString();
  const str = (v: unknown) => (typeof v === 'string' ? v : null);
  return {
    event_ts: iso,
    event_day: iso.slice(0, 10),
    request_id: requestId,
    account_id: str(rec.accountId),
    region: str(rec.region),
    operation: str(rec.operation),
    model_id: str(rec.modelId),
    identity_arn: str(rec.identity?.arn),
    schema_version: str(rec.schemaVersion),
    input_body_s3_path: str(rec.input?.inputBodyS3Path),
    source: 'cwlogs',
    ingest_ts: ingestTs,
    raw: rawText,
  };
}

/** Classify one text message (a log event or a direct-put record) into zero or more routed rows. */
export function rowsFromMessage(text: string, env: TransformEnv, ingestTs: string): RoutedRow[] | 'drop' | 'reject' {
  const t = text.trim();
  if (!t) return 'drop';
  const o = tryJson(t);
  if (o && typeof o === 'object') {
    const obj = o as Record<string, any>;
    if (typeof obj[REINGEST_MARKER] === 'string') {
      const target = String(obj[REINGEST_MARKER]);
      if (!ROUTABLE_TABLES.has(target) || !obj.row || typeof obj.row !== 'object') return 'reject';
      const [database, table] = target.split('.');
      return [{ database, table, row: obj.row }];
    }
    if (obj.schemaType === 'ModelInvocationLog' || (obj.requestId && obj.modelId && obj.input)) {
      const bronze = invocationRow(obj, t, ingestTs);
      if (!bronze) return 'drop';
      const rows: RoutedRow[] = [{ database: env.BRONZE_DATABASE, table: env.TABLE_INVOCATIONS, row: bronze as unknown as Record<string, unknown> }];
      try {
        const silver = buildSilverRow(obj as RawRecord, { ingestTs, maps: env.maps });
        rows.push({ database: env.SILVER_DATABASE, table: env.TABLE_SILVER_INVOCATIONS, row: silver.row as unknown as Record<string, unknown> });
        for (const a of silver.audit) rows.push({ database: env.SILVER_DATABASE, table: env.TABLE_ADAPTER_AUDIT, row: a as unknown as Record<string, unknown> });
      } catch (err) {
        console.error('lakehouse transform: silver row failed, bronze kept', (err as Error).message);
      }
      return rows;
    }
    if (isSpan(obj)) {
      const rows: RoutedRow[] = parseSpanRecord(t, ingestTs).map((row) => ({ database: env.BRONZE_DATABASE, table: env.TABLE_SPANS, row: row as unknown as Record<string, unknown> }));
      if (rows.length && isGenAiSpan(obj)) {
        try {
          const silver = buildSilverRowFromSpan(obj, { ingestTs, maps: env.maps });
          if (silver) rows.push({ database: env.SILVER_DATABASE, table: env.TABLE_SILVER_INVOCATIONS, row: silver.row as unknown as Record<string, unknown> });
        } catch (err) {
          console.error('lakehouse transform: silver span row failed, bronze kept', (err as Error).message);
        }
      }
      return rows;
    }
    if (isMetricDatapoint(obj)) return parseMetricStreamRecord(t, ingestTs).map((row) => ({ database: env.BRONZE_DATABASE, table: env.TABLE_METRICS, row: row as unknown as Record<string, unknown> }));
    return [];
  }
  // Not a single JSON object: maybe several newline-delimited metric datapoints.
  const metrics = parseMetricStreamRecord(t, ingestTs);
  if (metrics.length) return metrics.map((row) => ({ database: env.BRONZE_DATABASE, table: env.TABLE_METRICS, row: row as unknown as Record<string, unknown> }));
  return [];
}

function outputFor(recordId: string, env: TransformEnv, routed: RoutedRow): FirehoseOutputRecord {
  return {
    recordId,
    result: 'Ok',
    data: Buffer.from(JSON.stringify(routed.row), 'utf8').toString('base64'),
    metadata: { otfMetadata: { destinationDatabaseName: routed.database, destinationTableName: routed.table, operation: 'insert' } },
  };
}

export function transformRecord(recordId: string, data: Buffer, env: TransformEnv, now: Date = new Date()): TransformResult {
  const ingestTs = now.toISOString();
  const failed: TransformResult = { output: { recordId, result: 'ProcessingFailed', data: data.toString('base64') }, overflow: [] };
  const dropped: TransformResult = { output: { recordId, result: 'Dropped', data: data.toString('base64') }, overflow: [] };
  try {
    let rows: RoutedRow[] | 'drop' | 'reject';
    const unzipped = tryGunzip(data);
    if (unzipped === 'too-large') return failed;
    if (unzipped !== null) {
      const payload = tryJson(unzipped) as CwlPayload | undefined;
      if (!payload || !Array.isArray(payload.logEvents)) return failed;
      if (payload.messageType === 'CONTROL_MESSAGE') return dropped;
      rows = [];
      for (const ev of payload.logEvents) {
        if (typeof ev.message !== 'string') continue;
        const r = rowsFromMessage(ev.message, env, ingestTs);
        if (r === 'reject') return failed;
        if (r !== 'drop') rows.push(...r);
      }
      if (payload.logEvents.length > 0 && rows.length === 0) return dropped;
    } else {
      rows = rowsFromMessage(data.toString('utf8'), env, ingestTs);
    }
    if (rows === 'reject') return failed;
    if (rows === 'drop') return dropped;
    if (rows.length === 0) return failed;
    return { output: outputFor(recordId, env, rows[0]), overflow: rows.slice(1) };
  } catch {
    return failed;
  }
}

export function envFromProcess(e: NodeJS.ProcessEnv = process.env): TransformEnv {
  return {
    BRONZE_DATABASE: e.BRONZE_DATABASE ?? 'bronze',
    TABLE_INVOCATIONS: e.TABLE_INVOCATIONS ?? 'bedrock_invocations',
    TABLE_SPANS: e.TABLE_SPANS ?? 'otel_spans',
    TABLE_METRICS: e.TABLE_METRICS ?? 'cw_metrics',
    SILVER_DATABASE: e.SILVER_DATABASE ?? 'silver',
    TABLE_SILVER_INVOCATIONS: e.TABLE_SILVER_INVOCATIONS ?? 'invocations',
    TABLE_ADAPTER_AUDIT: e.TABLE_ADAPTER_AUDIT ?? 'adapter_audit',
    BEDROCK_LOG_GROUP: e.BEDROCK_LOG_GROUP,
    SPANS_LOG_GROUP: e.SPANS_LOG_GROUP,
    STREAM_NAME: e.STREAM_NAME,
  };
}

export function reingestRecords(rows: RoutedRow[]): Array<{ Data: Uint8Array }> {
  return rows.map((r) => ({ Data: Buffer.from(JSON.stringify({ [REINGEST_MARKER]: `${r.database}.${r.table}`, row: r.row }), 'utf8') }));
}

export interface Reingester { put(records: Array<{ Data: Uint8Array }>): Promise<void> }

export class FirehoseReingester implements Reingester {
  private client = new FirehoseClient({});
  constructor(private streamName: string) {}
  async put(records: Array<{ Data: Uint8Array }>): Promise<void> {
    for (let i = 0; i < records.length; i += 500) {
      const res = await this.client.send(new PutRecordBatchCommand({ DeliveryStreamName: this.streamName, Records: records.slice(i, i + 500) }));
      if ((res.FailedPutCount ?? 0) > 0) throw new Error(`PutRecordBatch: ${res.FailedPutCount} record(s) failed`);
    }
  }
}

/** Pure batch logic: transform every record, re-ingest overflow, downgrade to ProcessingFailed when re-ingest cannot happen. */
export async function processBatch(records: FirehoseInputRecord[], env: TransformEnv, reingester: Reingester | null, now: Date = new Date()): Promise<FirehoseOutputRecord[]> {
  const results = records.map((r) => ({ r, t: transformRecord(r.recordId, Buffer.from(r.data, 'base64'), env, now) }));
  const overflowOwners = results.filter((x) => x.t.overflow.length > 0);
  if (overflowOwners.length) {
    const all = overflowOwners.flatMap((x) => x.t.overflow);
    let ok = false;
    if (reingester) {
      try { await reingester.put(reingestRecords(all)); ok = true; } catch (err) { console.error('lakehouse transform: re-ingest failed', (err as Error).message); }
    } else {
      console.error(`lakehouse transform: ${all.length} overflow row(s) but no STREAM_NAME — returning the source records as ProcessingFailed`);
    }
    if (!ok) for (const x of overflowOwners) x.t.output = { recordId: x.r.recordId, result: 'ProcessingFailed', data: x.r.data };
  }
  return results.map((x) => x.t.output);
}

/** Registry snapshot for best-effort attribution, refreshed at most every 5 minutes per Lambda instance. */
const MAPS_TTL_MS = 5 * 60 * 1000;
let mapsCache: { at: number; maps: AttributionMaps } | null = null;
export async function attributionMaps(now = Date.now()): Promise<AttributionMaps | undefined> {
  if (!process.env.TENANTS_TABLE) return undefined;
  if (mapsCache && now - mapsCache.at < MAPS_TTL_MS) return mapsCache.maps;
  try {
    const { loadAttributionMaps } = await import('../shared/project-registry');
    mapsCache = { at: now, maps: await loadAttributionMaps() };
  } catch (err) {
    console.error('lakehouse transform: registry unreadable, attribution degraded to none', (err as Error).message);
    if (!mapsCache) return undefined;
  }
  return mapsCache.maps;
}

export const handler = async (event: { records: FirehoseInputRecord[] }): Promise<{ records: FirehoseOutputRecord[] }> => {
  const env = envFromProcess();
  env.maps = await attributionMaps();
  const reingester = env.STREAM_NAME ? new FirehoseReingester(env.STREAM_NAME) : null;
  return { records: await processBatch(event.records ?? [], env, reingester) };
};
