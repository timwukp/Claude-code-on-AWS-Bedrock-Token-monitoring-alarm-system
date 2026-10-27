import { BronzeOtelSpansRow } from './generated/row-types';

/**
 * Spans arrive in two shapes:
 *  - X-Ray Transaction Search writes them to the CloudWatch Logs group `aws/spans` as JSON with
 *    plain-object `attributes`, numeric `*TimeUnixNano`, `kind` like "SERVER" and an `_aws.xray` block
 *    (observed in this account, fixture span-xray.json);
 *  - OTLP/JSON (what an app or gateway exports) has `attributes: [{ key, value: { stringValue | intValue | … } }]`,
 *    string nanos and `kind` like "SPAN_KIND_CLIENT" (fixture span-otlp-genai.json).
 * Both become one bronze.otel_spans row; gen_ai.* attributes are kept as JSON text for silver.
 */
export function isSpan(o: unknown): boolean {
  return !!o && typeof o === 'object' && typeof (o as any).traceId === 'string' && typeof (o as any).spanId === 'string';
}

type Attr = { key: string; value: Record<string, unknown> };

function flattenAttributes(a: unknown): Record<string, unknown> {
  if (Array.isArray(a)) {
    const out: Record<string, unknown> = {};
    for (const kv of a as Attr[]) {
      if (!kv || typeof kv.key !== 'string') continue;
      const v = kv.value ?? {};
      const first = Object.entries(v)[0];
      if (!first) { out[kv.key] = null; continue; }
      const [kind, val] = first;
      out[kv.key] = kind === 'intValue' || kind === 'doubleValue' ? Number(val) : kind === 'arrayValue' ? flattenArray(val) : val;
    }
    return out;
  }
  if (a && typeof a === 'object') return a as Record<string, unknown>;
  return {};
}

function flattenArray(v: unknown): unknown[] {
  const values = (v as { values?: Array<Record<string, unknown>> })?.values ?? [];
  return values.map((x) => Object.values(x)[0]);
}

function nanosToIso(n: unknown): string | null {
  if (n === null || n === undefined) return null;
  const big = typeof n === 'string' ? BigInt(n) : typeof n === 'number' ? BigInt(Math.trunc(n)) : null;
  if (big === null) return null;
  return new Date(Number(big / 1_000_000n)).toISOString();
}

function normaliseKind(k: unknown): string | null {
  if (typeof k !== 'string') return null;
  return k.replace(/^SPAN_KIND_/, '');
}

function statusCode(s: unknown): string | null {
  const code = (s as { code?: unknown })?.code;
  if (typeof code === 'string') return code.replace(/^STATUS_CODE_/, '');
  if (typeof code === 'number') return ['UNSET', 'OK', 'ERROR'][code] ?? String(code);
  return null;
}

export function spanRow(span: Record<string, any>, rawText: string, ingestTs: string): BronzeOtelSpansRow | null {
  const start = nanosToIso(span.startTimeUnixNano);
  if (!start) return null;
  const end = nanosToIso(span.endTimeUnixNano);
  const attrs = flattenAttributes(span.attributes);
  const res = flattenAttributes(span.resource?.attributes);
  const duration = end ? (Number(BigInt(String(span.endTimeUnixNano).split('.')[0]) - BigInt(String(span.startTimeUnixNano).split('.')[0])) / 1_000_000) : null;
  return {
    span_ts: start,
    span_day: start.slice(0, 10),
    trace_id: String(span.traceId),
    span_id: String(span.spanId),
    parent_span_id: typeof span.parentSpanId === 'string' && span.parentSpanId ? span.parentSpanId : null,
    name: typeof span.name === 'string' ? span.name : null,
    service_name: typeof res['service.name'] === 'string' ? (res['service.name'] as string) : null,
    kind: normaliseKind(span.kind),
    duration_ms: duration !== null && Number.isFinite(duration) ? duration : null,
    status_code: statusCode(span.status),
    attributes: JSON.stringify(attrs),
    source: 'xray-transaction-search',
    ingest_ts: ingestTs,
    raw: rawText,
  };
}

/** Parse one log event / record that should hold a span. Returns [] when it is not a span. */
export function parseSpanRecord(text: string, ingestTs: string): BronzeOtelSpansRow[] {
  const t = text.trim();
  if (!t) return [];
  let o: unknown;
  try { o = JSON.parse(t); } catch { return []; }
  if (!isSpan(o)) return [];
  const row = spanRow(o as Record<string, any>, t, ingestTs);
  return row ? [row] : [];
}
