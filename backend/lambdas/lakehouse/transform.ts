/**
 * Firehose data-transformation Lambda for the bronze layer.
 *
 * Every Firehose record becomes exactly one bronze row routed by `metadata.otfMetadata` to its
 * Iceberg table. The destination accepts ONE JSON object per record ("You can send only one JSON
 * object in one Firehose record. If you aggregate and send multiple JSON objects inside a record,
 * Firehose throws an error and delivers data to the S3 error bucket" — Apache Iceberg destination,
 * Considerations and limitations). So:
 *  - the stream is configured with Firehose's own `Decompression` + `CloudWatchLogProcessing`
 *    (message extraction) processors ahead of this Lambda, which turns a CloudWatch Logs batch into
 *    one record per log event — the normal path is one-in, one-out;
 *  - if a record still carries several rows (a raw gzip CloudWatch payload with N events, or a
 *    Metric Streams record with N datapoints), the FIRST row answers the recordId and the rest are
 *    re-ingested into the same stream with `firehose:PutRecordBatch`, pre-routed as
 *    `{ "__tums_table": "<table>", "row": {...} }`, which this Lambda passes straight through;
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

export interface TransformEnv {
  BRONZE_DATABASE: string;
  TABLE_INVOCATIONS: string;
  TABLE_SPANS: string;
  TABLE_METRICS: string;
  BEDROCK_LOG_GROUP?: string;
  SPANS_LOG_GROUP?: string;
  STREAM_NAME?: string;
}

export interface FirehoseInputRecord { recordId: string; data: string; approximateArrivalTimestamp?: number }

export interface FirehoseOutputRecord {
  recordId: string;
  result: 'Ok' | 'Dropped' | 'ProcessingFailed';
  data: string;
  metadata?: { otfMetadata: { destinationDatabaseName: string; destinationTableName: string; operation: 'insert' } };
}

export interface RoutedRow { table: string; row: Record<string, unknown> }

export interface TransformResult {
  output: FirehoseOutputRecord;
  /** Rows beyond the first, to be re-ingested (empty on the normal one-in-one-out path). */
  overflow: RoutedRow[];
}

const REINGEST_MARKER = '__tums_table';

interface CwlPayload { messageType?: string; logGroup?: string; logEvents?: Array<{ id?: string; timestamp?: number; message?: string }> }

function tryGunzip(buf: Buffer): string | null {
  if (buf.length < 2 || buf[0] !== 0x1f || buf[1] !== 0x8b) return null;
  try { return gunzipSync(buf).toString('utf8'); } catch { return null; }
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
export function rowsFromMessage(text: string, env: TransformEnv, ingestTs: string): RoutedRow[] | 'drop' {
  const t = text.trim();
  if (!t) return 'drop';
  const o = tryJson(t);
  if (o && typeof o === 'object') {
    const obj = o as Record<string, any>;
    if (typeof obj[REINGEST_MARKER] === 'string' && obj.row && typeof obj.row === 'object') return [{ table: obj[REINGEST_MARKER], row: obj.row }];
    if (obj.schemaType === 'ModelInvocationLog' || (obj.requestId && obj.modelId && obj.input)) {
      const row = invocationRow(obj, t, ingestTs);
      return row ? [{ table: env.TABLE_INVOCATIONS, row: row as unknown as Record<string, unknown> }] : 'drop';
    }
    if (isSpan(obj)) return parseSpanRecord(t, ingestTs).map((row) => ({ table: env.TABLE_SPANS, row: row as unknown as Record<string, unknown> }));
    if (isMetricDatapoint(obj)) return parseMetricStreamRecord(t, ingestTs).map((row) => ({ table: env.TABLE_METRICS, row: row as unknown as Record<string, unknown> }));
    return [];
  }
  // Not a single JSON object: maybe several newline-delimited metric datapoints.
  const metrics = parseMetricStreamRecord(t, ingestTs);
  if (metrics.length) return metrics.map((row) => ({ table: env.TABLE_METRICS, row: row as unknown as Record<string, unknown> }));
  return [];
}

function outputFor(recordId: string, env: TransformEnv, routed: RoutedRow): FirehoseOutputRecord {
  return {
    recordId,
    result: 'Ok',
    data: Buffer.from(JSON.stringify(routed.row), 'utf8').toString('base64'),
    metadata: { otfMetadata: { destinationDatabaseName: env.BRONZE_DATABASE, destinationTableName: routed.table, operation: 'insert' } },
  };
}

export function transformRecord(recordId: string, data: Buffer, env: TransformEnv, now: Date = new Date()): TransformResult {
  const ingestTs = now.toISOString();
  const failed: TransformResult = { output: { recordId, result: 'ProcessingFailed', data: data.toString('base64') }, overflow: [] };
  const dropped: TransformResult = { output: { recordId, result: 'Dropped', data: data.toString('base64') }, overflow: [] };
  try {
    let rows: RoutedRow[] | 'drop';
    const unzipped = tryGunzip(data);
    if (unzipped !== null) {
      const payload = tryJson(unzipped) as CwlPayload | undefined;
      if (!payload || !Array.isArray(payload.logEvents)) return failed;
      if (payload.messageType === 'CONTROL_MESSAGE') return dropped;
      rows = [];
      for (const ev of payload.logEvents) {
        if (typeof ev.message !== 'string') continue;
        const r = rowsFromMessage(ev.message, env, ingestTs);
        if (r !== 'drop') rows.push(...r);
      }
      if (payload.logEvents.length > 0 && rows.length === 0) return dropped;
    } else {
      rows = rowsFromMessage(data.toString('utf8'), env, ingestTs);
    }
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
    BEDROCK_LOG_GROUP: e.BEDROCK_LOG_GROUP,
    SPANS_LOG_GROUP: e.SPANS_LOG_GROUP,
    STREAM_NAME: e.STREAM_NAME,
  };
}

export function reingestRecords(rows: RoutedRow[]): Array<{ Data: Uint8Array }> {
  return rows.map((r) => ({ Data: Buffer.from(JSON.stringify({ [REINGEST_MARKER]: r.table, row: r.row }), 'utf8') }));
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

export const handler = async (event: { records: FirehoseInputRecord[] }): Promise<{ records: FirehoseOutputRecord[] }> => {
  const env = envFromProcess();
  const reingester = env.STREAM_NAME ? new FirehoseReingester(env.STREAM_NAME) : null;
  return { records: await processBatch(event.records ?? [], env, reingester) };
};
