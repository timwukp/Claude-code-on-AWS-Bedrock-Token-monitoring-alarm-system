import * as fs from 'fs';
import * as path from 'path';
import { parseSpanRecord } from './otel-span';

const read = (f: string) => fs.readFileSync(path.join(__dirname, 'fixtures', f), 'utf8');
const NOW = '2026-10-27T03:00:00.000Z';

describe('parseSpanRecord', () => {
  it('parses the X-Ray Transaction Search shape found in aws/spans (object attributes, numeric nanos)', () => {
    const [row] = parseSpanRecord(read('span-xray.json'), NOW);
    expect(row).toMatchObject({
      trace_id: '6ab8b9186fd709c34131c3856d775599', span_id: '54b60435b9f68fa4', parent_span_id: null,
      name: 'Tums-dev-Etl-AggregatorFn/LambdaService', service_name: 'Tums-dev-Etl-AggregatorFn', kind: 'SERVER',
      status_code: 'UNSET', span_ts: '2026-10-27T00:00:00.128Z', span_day: '2026-10-27', source: 'xray-transaction-search', ingest_ts: NOW,
    });
    expect(row.duration_ms).toBeCloseTo(1200, 3);
    expect(JSON.parse(row.attributes!)['aws.request_id']).toBe('e11e38ed-b90c-46b5-9235-7a10af339f1d');
    expect(row.raw).toBe(read('span-xray.json').trim());
  });

  it('parses the OTLP/JSON shape a gateway exports (array attributes, string nanos, SPAN_KIND_/STATUS_CODE_ prefixes)', () => {
    const [row] = parseSpanRecord(read('span-otlp-genai.json'), NOW);
    expect(row).toMatchObject({ kind: 'CLIENT', status_code: 'OK', parent_span_id: 'a1b2c3d4e5f60718', service_name: 'llm-trusted-gateway', span_ts: '2026-10-27T00:00:00.000Z' });
    expect(row.duration_ms).toBe(3500);
    const attrs = JSON.parse(row.attributes!);
    expect(attrs).toMatchObject({ 'gen_ai.provider.name': 'aws.bedrock', 'gen_ai.request.model': 'us.anthropic.claude-opus-5-5', 'gen_ai.usage.input_tokens': 1200, 'gen_ai.usage.output_tokens': 340 });
  });

  it('an in-progress span (no end time) has a null duration; a non-span or garbage yields nothing', () => {
    const inProgress = JSON.parse(read('span-xray.json')); inProgress.endTimeUnixNano = null;
    expect(parseSpanRecord(JSON.stringify(inProgress), NOW)[0].duration_ms).toBeNull();
    expect(parseSpanRecord('{"schemaType":"ModelInvocationLog"}', NOW)).toEqual([]);
    expect(parseSpanRecord('nope', NOW)).toEqual([]);
    expect(parseSpanRecord('', NOW)).toEqual([]);
  });
});
