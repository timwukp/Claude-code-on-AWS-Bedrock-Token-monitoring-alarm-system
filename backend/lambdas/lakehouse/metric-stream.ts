import { BronzeCwMetricsRow } from './generated/row-types';

/**
 * CloudWatch Metric Streams, JSON output format: one JSON object per line —
 * { metric_stream_name, account_id, region, namespace, metric_name, dimensions{}, timestamp(ms),
 *   value{ sum, count, min, max, [extra statistics] }, unit }.
 * Unknown fields are kept in `raw` and otherwise ignored; a missing statistic becomes null.
 */
export interface MetricStreamDatapoint {
  namespace?: string;
  metric_name?: string;
  dimensions?: Record<string, string>;
  timestamp?: number;
  value?: { sum?: number; count?: number; min?: number; max?: number };
  unit?: string;
  [k: string]: unknown;
}

export function isMetricDatapoint(o: unknown): o is MetricStreamDatapoint {
  return !!o && typeof o === 'object' && typeof (o as any).namespace === 'string' && typeof (o as any).metric_name === 'string' && typeof (o as any).timestamp === 'number';
}

export function utcDay(iso: string): string {
  return iso.slice(0, 10);
}

export function metricRow(dp: MetricStreamDatapoint, rawText: string, ingestTs: string): BronzeCwMetricsRow {
  const ts = new Date(dp.timestamp as number).toISOString();
  const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  return {
    metric_ts: ts,
    metric_day: utcDay(ts),
    namespace: dp.namespace as string,
    metric_name: dp.metric_name as string,
    dimensions: JSON.stringify(dp.dimensions ?? {}),
    unit: typeof dp.unit === 'string' ? dp.unit : null,
    sum: num(dp.value?.sum),
    count: num(dp.value?.count),
    min: num(dp.value?.min),
    max: num(dp.value?.max),
    source: 'metric-stream',
    ingest_ts: ingestTs,
    raw: rawText,
  };
}

/** Parse a Metric Streams record (one or many newline-delimited datapoints). Lines that are not datapoints are skipped. */
export function parseMetricStreamRecord(text: string, ingestTs: string): BronzeCwMetricsRow[] {
  const rows: BronzeCwMetricsRow[] = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    let o: unknown;
    try { o = JSON.parse(t); } catch { continue; }
    if (isMetricDatapoint(o)) rows.push(metricRow(o, t, ingestTs));
  }
  return rows;
}
