import * as fs from 'fs';
import * as path from 'path';
import { gzipSync } from 'zlib';
import { MAX_INFLATED_BYTES, processBatch, Reingester, ROUTABLE_TABLES, transformRecord, TransformEnv } from './transform';
import { AttributionMaps } from '../ingestion/parse';

const ENV: TransformEnv = { BRONZE_DATABASE: 'bronze', TABLE_INVOCATIONS: 'bedrock_invocations', TABLE_SPANS: 'otel_spans', TABLE_METRICS: 'cw_metrics', SILVER_DATABASE: 'silver', TABLE_SILVER_INVOCATIONS: 'invocations', TABLE_ADAPTER_AUDIT: 'adapter_audit', STREAM_NAME: 'fh-bedrock' };
const NOW = new Date('2026-10-27T03:00:00.000Z');
const fixture = (f: string) => fs.readFileSync(path.join(__dirname, 'fixtures', f), 'utf8');
const b64 = (s: string | Buffer) => Buffer.from(s).toString('base64');
const decode = (out: { data: string }) => JSON.parse(Buffer.from(out.data, 'base64').toString('utf8'));

// Shape from backend/lambdas/ingestion/parse.test.ts — a real Bedrock invocation log record.
const RECORD = {
  schemaType: 'ModelInvocationLog', schemaVersion: '1.0', timestamp: '2026-10-27T02:54:27Z', accountId: '123456789012', region: 'us-east-1',
  requestId: 'req-1', operation: 'InvokeModelWithResponseStream', modelId: 'arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.anthropic.claude-opus-5-5',
  identity: { arn: 'arn:aws:iam::123456789012:user/alice' }, requestMetadata: { tenant: 'team-a', project_id: 'p1' },
  input: { inputContentType: 'application/json', inputBodyJson: { messages: [{ role: 'user', content: 'hi' }] }, inputTokenCount: 100, cacheReadInputTokenCount: 40, cacheWriteInputTokenCount: 10 },
  output: { outputContentType: 'application/json', outputBodyJson: { content: [{ type: 'text', text: 'hello' }] }, outputTokenCount: 25 },
};
// The 2026-10-23 shape: an OpenAI Responses-API request whose body has a top-level `input` ARRAY.
const RESPONSES_RECORD = {
  ...RECORD, requestId: 'req-2', modelId: 'us.openai.gpt-6-luna', operation: 'InvokeModel',
  input: { inputContentType: 'application/json', inputBodyS3Path: 's3://bodies/2026/10/27/02/data/abc_input.json.gz', inputTokenCount: 48000, cacheReadInputTokenCount: 0, cacheWriteInputTokenCount: 0 },
};
const cwl = (events: unknown[], messageType = 'DATA_MESSAGE', logGroup = '/aws/bedrock/modelinvocations') =>
  gzipSync(Buffer.from(JSON.stringify({ messageType, owner: '123456789012', logGroup, logStream: 'aws/bedrock/modelinvocations', subscriptionFilters: ['f'], logEvents: events.map((m, i) => ({ id: String(i), timestamp: 1793068467000, message: typeof m === 'string' ? m : JSON.stringify(m) })) })));

describe('transformRecord — one record in, bronze row out (silver rows overflow)', () => {
  it('a Bedrock invocation record → bronze.bedrock_invocations first, silver.invocations as overflow', () => {
    const { output, overflow } = transformRecord('r1', Buffer.from(JSON.stringify(RECORD)), ENV, NOW);
    expect(overflow.map((o) => `${o.database}.${o.table}`)).toEqual(['silver.invocations']);
    expect(output.result).toBe('Ok');
    expect(output.metadata).toEqual({ otfMetadata: { destinationDatabaseName: 'bronze', destinationTableName: 'bedrock_invocations', operation: 'insert' } });
    const row = decode(output);
    expect(row).toMatchObject({ event_ts: '2026-10-27T02:54:27.000Z', event_day: '2026-10-27', request_id: 'req-1', account_id: '123456789012', region: 'us-east-1', operation: 'InvokeModelWithResponseStream', identity_arn: 'arn:aws:iam::123456789012:user/alice', schema_version: '1.0', input_body_s3_path: null, source: 'cwlogs', ingest_ts: '2026-10-27T03:00:00.000Z' });
    expect(row.model_id).toBe(RECORD.modelId);
    expect(JSON.parse(row.raw)).toEqual(RECORD); // verbatim, inline body included
    expect(Object.keys(row).sort()).toEqual(['account_id', 'event_day', 'event_ts', 'identity_arn', 'ingest_ts', 'input_body_s3_path', 'model_id', 'operation', 'raw', 'region', 'request_id', 'schema_version', 'source']);
  });

  it('a Responses-API-shaped record is just another row — the shape that killed the Athena table is inert here', () => {
    const { output } = transformRecord('r2', Buffer.from(JSON.stringify(RESPONSES_RECORD)), ENV, NOW);
    expect(output.result).toBe('Ok');
    expect(decode(output)).toMatchObject({ request_id: 'req-2', model_id: 'us.openai.gpt-6-luna', input_body_s3_path: 's3://bodies/2026/10/27/02/data/abc_input.json.gz' });
  });

  it('a span → bronze.otel_spans; a metric datapoint → bronze.cw_metrics', () => {
    const span = transformRecord('s', Buffer.from(fixture('span-otlp-genai.json')), ENV, NOW);
    expect(span.output.metadata!.otfMetadata.destinationTableName).toBe('otel_spans');
    expect(decode(span.output)).toMatchObject({ trace_id: '4bf92f3577b34da6a3ce929d0e0e4736', service_name: 'llm-trusted-gateway' });
    // a GenAI span also yields a silver row (source otel) carrying the OTel ids
    expect(span.overflow.map((o) => `${o.database}.${o.table}`)).toEqual(['silver.invocations']);
    expect(span.overflow[0].row).toMatchObject({ source: 'otel', request_id: '0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0', trace_id: '4bf92f3577b34da6a3ce929d0e0e4736', span_id: '00f067aa0ba902b7', input_tokens: 1200, output_tokens: 340, service_name: 'llm-trusted-gateway' });
    const metric = transformRecord('m', Buffer.from(fixture('metric-stream.jsonl').split('\n')[0]), ENV, NOW);
    expect(metric.output.metadata!.otfMetadata.destinationTableName).toBe('cw_metrics');
    expect(decode(metric.output)).toMatchObject({ namespace: 'AWS/Bedrock', metric_name: 'InputTokenCount' });
  });

  it('a raw gzip CloudWatch payload with N events: first row answers the recordId, the rest overflow', () => {
    const { output, overflow } = transformRecord('g', cwl([RECORD, RESPONSES_RECORD, { ...RECORD, requestId: 'req-3' }]), ENV, NOW);
    expect(output.result).toBe('Ok');
    expect(decode(output).request_id).toBe('req-1');
    expect(overflow.map((o) => [`${o.database}.${o.table}`, (o.row as any).request_id])).toEqual([
      ['silver.invocations', 'req-1'], ['bronze.bedrock_invocations', 'req-2'], ['silver.invocations', 'req-2'], ['bronze.bedrock_invocations', 'req-3'], ['silver.invocations', 'req-3'],
    ]);
  });

  it('a Metric Streams record with several datapoints overflows the same way', () => {
    const { output, overflow } = transformRecord('mm', Buffer.from(fixture('metric-stream.jsonl')), ENV, NOW);
    expect(output.result).toBe('Ok');
    expect(overflow).toHaveLength(2);
    expect(overflow.every((o) => o.table === 'cw_metrics')).toBe(true);
  });

  it('a re-ingested, pre-routed row passes straight through to its table', () => {
    const wrapped = JSON.stringify({ __tums_table: 'bronze.cw_metrics', row: { metric_ts: '2026-10-27T00:00:00.000Z', metric_day: '2026-10-27', namespace: 'AWS/Bedrock', metric_name: 'X', source: 'metric-stream', ingest_ts: NOW.toISOString(), raw: '{}' } });
    const { output, overflow } = transformRecord('w', Buffer.from(wrapped), ENV, NOW);
    expect(overflow).toEqual([]);
    expect(output.metadata!.otfMetadata).toEqual({ destinationDatabaseName: 'bronze', destinationTableName: 'cw_metrics', operation: 'insert' });
    expect(decode(output).metric_name).toBe('X');
  });

  it('a re-ingested row may only target a table the spec knows — anything else is ProcessingFailed, never routed', () => {
    expect([...ROUTABLE_TABLES].sort()).toEqual(['bronze.bedrock_invocations', 'bronze.cw_metrics', 'bronze.otel_spans', 'silver.adapter_audit', 'silver.bedrock_metrics_hourly', 'silver.bill_daily', 'silver.dim_model', 'silver.invocations', 'silver.project_registry']);
    for (const bad of ['gold.cost_by_project_model_day', 'bronze.cur_raw', 'cw_metrics', 'silver.invocations; DROP TABLE x', '../../etc', '']) {
      const r = transformRecord('bad', Buffer.from(JSON.stringify({ __tums_table: bad, row: { a: 1 } })), ENV, NOW);
      expect(r.output.result).toBe('ProcessingFailed');
      expect(r.output.metadata).toBeUndefined();
    }
    const noRow = transformRecord('nr', Buffer.from(JSON.stringify({ __tums_table: 'bronze.cw_metrics' })), ENV, NOW);
    expect(noRow.output.result).toBe('ProcessingFailed');
  });

  it('a gzip envelope that inflates past the cap is ProcessingFailed instead of exhausting the Lambda', () => {
    expect(MAX_INFLATED_BYTES).toBe(64 * 1024 * 1024);
    const bomb = gzipSync(Buffer.alloc(MAX_INFLATED_BYTES + 1024, 0x20)); // ~64 KB on the wire, 64 MiB inflated
    const r = transformRecord('bomb', bomb, ENV, NOW);
    expect(r.output.result).toBe('ProcessingFailed');
    expect(r.output.data).toBe(bomb.toString('base64'));
  });

  it('silver rows carry attribution from the registry snapshot when provided, none when absent', () => {
    const maps: AttributionMaps = { profiles: new Map([[RECORD.modelId, { projectId: 'proj-x', underlyingModelId: 'us.anthropic.claude-opus-5-5' }]]), identities: new Map() };
    const withMaps = transformRecord('a', Buffer.from(JSON.stringify(RECORD)), { ...ENV, maps }, NOW);
    expect(withMaps.overflow[0].row).toMatchObject({ project_id: 'proj-x', attribution_source: 'aip', model_key: 'anthropic.claude-opus-5-5', tenant_key: 'team-a' });
    const without = transformRecord('b', Buffer.from(JSON.stringify(RECORD)), ENV, NOW);
    expect(without.overflow[0].row).toMatchObject({ project_id: 'p1', attribution_source: 'metadata' }); // requestMetadata.project_id still works without a registry
    const bare = transformRecord('c', Buffer.from(JSON.stringify({ ...RECORD, requestMetadata: undefined })), ENV, NOW);
    expect(bare.overflow[0].row).toMatchObject({ project_id: 'untagged', attribution_source: 'none', tenant_key: 'arn:aws:iam::123456789012:user/alice' });
  });

  it('an adapter disagreement produces a silver.adapter_audit row beside the silver row', () => {
    const rec = { ...RECORD, output: { ...RECORD.output, outputBodyJson: { type: 'message', stop_reason: 'end_turn', content: [], usage: { input_tokens: 777, output_tokens: 25 } } } };
    const { overflow } = transformRecord('d', Buffer.from(JSON.stringify(rec)), ENV, NOW);
    expect(overflow.map((o) => `${o.database}.${o.table}`)).toEqual(['silver.invocations', 'silver.adapter_audit']);
    expect(overflow[0].row).toMatchObject({ input_tokens: 100, adapter_discrepancy: true, finish_reason: 'end_turn', token_source: 'envelope' });
    expect(overflow[1].row).toMatchObject({ request_id: 'req-1', field: 'input_tokens', envelope_value: '100', adapter_value: '777' });
  });

  it('CONTROL_MESSAGE and permission-check markers are Dropped; garbage is ProcessingFailed with the original bytes', () => {
    expect(transformRecord('c', cwl(['x'], 'CONTROL_MESSAGE'), ENV, NOW).output.result).toBe('Dropped');
    expect(transformRecord('p', Buffer.from(JSON.stringify({ schemaType: 'ModelInvocationLog' })), ENV, NOW).output.result).toBe('Dropped'); // no requestId/timestamp
    const garbage = Buffer.from([0x00, 0xff, 0x1f, 0x8b, 0x13]);
    const g = transformRecord('x', garbage, ENV, NOW);
    expect(g.output).toEqual({ recordId: 'x', result: 'ProcessingFailed', data: garbage.toString('base64') });
    expect(transformRecord('j', Buffer.from('{"hello":"world"}'), ENV, NOW).output.result).toBe('ProcessingFailed');
  });

  it('never throws', () => {
    for (const d of [Buffer.alloc(0), Buffer.from('\u0000'), gzipSync(Buffer.from('not json')), Buffer.from('[1,2,3]'), Buffer.from('a'.repeat(100000))]) {
      expect(() => transformRecord('z', d, ENV, NOW)).not.toThrow();
    }
  });
});

describe('processBatch — overflow re-ingest', () => {
  const batch = [
    { recordId: 'a', data: b64(cwl([RECORD, RESPONSES_RECORD])) },
    { recordId: 'b', data: b64(JSON.stringify(RECORD)) },
  ];

  it('re-ingests overflow rows pre-routed, one Firehose record each, and keeps the first rows Ok', async () => {
    const seen: string[] = [];
    const reingester: Reingester = { put: async (recs) => { seen.push(...recs.map((r) => Buffer.from(r.Data).toString('utf8'))); } };
    const out = await processBatch(batch, ENV, reingester, NOW);
    expect(out.map((o) => [o.recordId, o.result])).toEqual([['a', 'Ok'], ['b', 'Ok']]);
    // a: [bronze req-1 answers] + overflow silver req-1, bronze req-2, silver req-2; b: [bronze req-1] + silver req-1
    expect(seen).toHaveLength(4);
    const w = seen.map((x) => JSON.parse(x));
    expect(w.map((x) => x.__tums_table)).toEqual(['silver.invocations', 'bronze.bedrock_invocations', 'silver.invocations', 'silver.invocations']);
    expect(w[1].row.request_id).toBe('req-2');
  });

  it('when re-ingest fails or no stream is configured, the multi-row record becomes ProcessingFailed (nothing silently lost)', async () => {
    const failing: Reingester = { put: async () => { throw new Error('throttled'); } };
    const out1 = await processBatch(batch, ENV, failing, NOW);
    expect(out1.map((o) => o.result)).toEqual(['ProcessingFailed', 'ProcessingFailed']); // both now carry a silver overflow row
    expect(out1[0].data).toBe(batch[0].data);
    const out2 = await processBatch(batch, { ...ENV, STREAM_NAME: undefined }, null, NOW);
    expect(out2.map((o) => o.result)).toEqual(['ProcessingFailed', 'ProcessingFailed']);
  });

  it('answers every recordId exactly once, in order', async () => {
    const out = await processBatch([...batch, { recordId: 'c', data: b64('garbage') }], ENV, { put: async () => {} }, NOW);
    expect(out.map((o) => o.recordId)).toEqual(['a', 'b', 'c']);
    expect(out[2].result).toBe('ProcessingFailed');
  });
});
