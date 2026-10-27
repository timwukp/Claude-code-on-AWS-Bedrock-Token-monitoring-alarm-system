import * as fs from 'fs';
import * as path from 'path';
import { isMetricDatapoint, parseMetricStreamRecord } from './metric-stream';

const FIX = fs.readFileSync(path.join(__dirname, 'fixtures', 'metric-stream.jsonl'), 'utf8');
const NOW = '2026-10-27T03:00:00.000Z';

describe('parseMetricStreamRecord', () => {
  const rows = parseMetricStreamRecord(FIX, NOW);

  it('yields one bronze.cw_metrics row per datapoint line, partitioned by UTC day', () => {
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ namespace: 'AWS/Bedrock', metric_name: 'InputTokenCount', metric_ts: '2026-10-27T00:00:00.000Z', metric_day: '2026-10-27', unit: 'Count', sum: 1932112, count: 412, min: 3, max: 12050, source: 'metric-stream', ingest_ts: NOW });
    expect(JSON.parse(rows[0].dimensions!)).toEqual({ ModelId: 'us.anthropic.claude-opus-5-5' });
  });

  it('keeps Mantle dimensions (Model + Project) as JSON text, the raw line verbatim', () => {
    expect(rows[1].namespace).toBe('AWS/BedrockMantle');
    expect(JSON.parse(rows[1].dimensions!)).toEqual({ Model: 'openai.gpt-6-luna', Project: 'ltg-asean-sim' });
    expect(rows[1].raw).toBe(FIX.split('\n')[1]);
  });

  it('tolerates missing statistics and unknown fields', () => {
    expect(rows[2]).toMatchObject({ metric_name: 'InvocationLatency', sum: 48123.5, count: 17, min: null, max: null, unit: 'Milliseconds' });
    expect(JSON.parse(rows[2].dimensions!)).toEqual({});
  });

  it('skips blank lines, non-JSON and objects that are not datapoints', () => {
    expect(parseMetricStreamRecord('\n{not json}\n{"namespace":"x"}\n{"schemaType":"ModelInvocationLog"}\n', NOW)).toEqual([]);
    expect(isMetricDatapoint({ namespace: 'AWS/Bedrock', metric_name: 'X', timestamp: '1' })).toBe(false);
  });
});
