import { useEffect, useMemo, useState } from 'react';
import { Disclosure, Kpi, Panel } from '../components/Layout';
import { api, LatencyHop, LatencyResponse, LatencyRow, LatencyStat } from '../api/client';

const WINDOWS = [1, 7, 30] as const;
const PERCENTILES = ['p50', 'p95', 'p99'] as const;

/** Longer windows can span several CloudWatch buckets; say so at the number rather than only in the
 *  caveats, since a weighted mean of percentiles is not the same claim as a measured percentile. */
const APPROX_FOOT = (approximated?: true): string =>
  approximated ? ' · weighted mean across CloudWatch buckets' : '';
type Percentile = (typeof PERCENTILES)[number];

const fmtMs = (ms: number | null): string =>
  ms === null ? '—' : ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${ms} ms`;

/**
 * The routing prefix of a model id. The same model reached through different inference routes is a
 * separate CloudWatch series with genuinely different latency, so where two rows would otherwise
 * carry the same name we show the route rather than letting them look like a duplicate.
 */
const scopeOf = (modelId: string): string => /^(us|eu|apac|global)\./.exec(modelId)?.[1] ?? 'direct';

const MEASURED = '#3b82f6';
const MEASURED_2 = '#8b5cf6';
const UNMEASURED = '#64748b';

/** Geometry for one hop: a box on the chain, sized by measured latency where we have it. */
interface Segment {
  hop: LatencyHop;
  x: number;
  width: number;
  ms: number | null;
  /** Share of the animation's total duration — proportional to ms for measured hops. */
  timeShare: number;
  colour: string;
}

const CHAIN_X = 24;
const CHAIN_W = 912;
const UNMEASURED_W = 108;

/**
 * Lays the five hops out left to right. Measured hops share the leftover width in proportion to
 * their latency; unmeasured hops get a fixed narrow box, because giving them a width would imply a
 * duration we have not measured.
 */
function layout(hops: LatencyHop[], row: { ttft: LatencyStat; generation: LatencyStat }, p: Percentile): Segment[] {
  const msOf = (hop: LatencyHop): number | null =>
    hop.metric === 'ttft' ? row.ttft[p] : hop.metric === 'generation' ? row.generation[p] : null;

  const unmeasuredCount = hops.filter((h) => h.status !== 'measured').length;
  const measuredTotal = hops.reduce((sum, h) => sum + (msOf(h) ?? 0), 0);
  const measuredWidth = CHAIN_W - unmeasuredCount * UNMEASURED_W;

  let x = CHAIN_X;
  return hops.map((hop) => {
    const ms = msOf(hop);
    const width =
      hop.status === 'measured' && measuredTotal > 0
        ? Math.max(46, ((ms ?? 0) / measuredTotal) * measuredWidth)
        : UNMEASURED_W;
    // Unmeasured hops still need the dot to move through them, so give each a nominal slice.
    const timeShare = hop.status === 'measured' ? Math.max(1, ms ?? 0) : Math.max(1, measuredTotal * 0.08);
    const seg: Segment = {
      hop,
      x,
      width,
      ms,
      timeShare,
      colour: hop.status !== 'measured' ? UNMEASURED : hop.metric === 'ttft' ? MEASURED : MEASURED_2,
    };
    x += width;
    return seg;
  });
}

/**
 * The chain, drawn to scale where we can measure and explicitly hollow where we cannot. The
 * travelling dot dwells in each hop in proportion to its measured latency, so the shape of the
 * delay is visible rather than asserted. Animation is SMIL so the component needs no CSS of its own.
 */
function ChainDiagram({ segments, percentile }: { segments: Segment[]; percentile: Percentile }) {
  const totalTime = segments.reduce((s, g) => s + g.timeShare, 0);
  const DUR = 5;

  // cx keyframes: enter each box, cross it, hand over to the next.
  const xs: number[] = [CHAIN_X];
  const times: number[] = [0];
  let acc = 0;
  for (const g of segments) {
    acc += g.timeShare;
    xs.push(g.x + g.width);
    times.push(acc / totalTime);
  }

  const measuredMs = segments.filter((g) => g.hop.status === 'measured').reduce((s, g) => s + (g.ms ?? 0), 0);

  return (
    <svg viewBox="0 0 960 250" width="100%" role="img"
      aria-label={`End-to-end request chain. Measured Bedrock hop total ${fmtMs(measuredMs)} at ${percentile}. Three hops are not measured.`}>
      <line x1={CHAIN_X} y1={104} x2={CHAIN_X + CHAIN_W} y2={104} stroke="#334155" strokeWidth={2} />

      {segments.map((g) => {
        const measured = g.hop.status === 'measured';
        return (
          <g key={g.hop.id}>
            <rect
              x={g.x + 3} y={78} width={Math.max(0, g.width - 6)} height={52} rx={7}
              fill={measured ? g.colour : 'none'} fillOpacity={measured ? 0.22 : 0}
              stroke={g.colour} strokeWidth={measured ? 2 : 1.5}
              strokeDasharray={measured ? undefined : '5 4'}
            />
            {measured && (
              <text x={g.x + g.width / 2} y={110} textAnchor="middle" fill="#e2e8f0" fontSize={17} fontWeight={600}>
                {fmtMs(g.ms)}
              </text>
            )}
            {!measured && (
              <text x={g.x + g.width / 2} y={110} textAnchor="middle" fill={UNMEASURED} fontSize={20} fontWeight={700}>?</text>
            )}
            <text x={g.x + g.width / 2} y={64} textAnchor="middle" fill="#94a3b8" fontSize={11}>
              {g.hop.label.length > 22 ? `${g.hop.label.slice(0, 21)}…` : g.hop.label}
            </text>
            <text x={g.x + g.width / 2} y={150} textAnchor="middle" fill={measured ? '#64748b' : UNMEASURED} fontSize={10}>
              {measured ? 'measured' : 'not measured'}
            </text>
            {!measured && (
              <text x={g.x + g.width / 2} y={164} textAnchor="middle" fill={UNMEASURED} fontSize={9}>
                {g.hop.id === 'client' ? 'needs client OTel' : g.hop.id === 'gateway' ? 'needs gateway metrics' : 'needs Converse trace'}
              </text>
            )}
          </g>
        );
      })}

      {/* The request travelling the chain. */}
      <circle r={7} fill="#f8fafc">
        <animate attributeName="cx" values={xs.join(';')} keyTimes={times.join(';')}
          dur={`${DUR}s`} repeatCount="indefinite" />
        <animate attributeName="cy" values="104" dur={`${DUR}s`} repeatCount="indefinite" />
        <animate attributeName="opacity" values="0;1;1;0" keyTimes="0;0.04;0.96;1" dur={`${DUR}s`} repeatCount="indefinite" />
      </circle>

      <text x={CHAIN_X} y={200} fill="#94a3b8" fontSize={11}>
        Box width and the dot's dwell time are proportional to measured milliseconds at {percentile}.
      </text>
      <text x={CHAIN_X} y={218} fill="#94a3b8" fontSize={11}>
        Dashed hops are outside our telemetry — they are drawn at a fixed width because we have no number for them.
      </text>
      <text x={CHAIN_X} y={236} fill="#e2e8f0" fontSize={12} fontWeight={600}>
        Measured portion of the round trip: {fmtMs(measuredMs)}
      </text>
    </svg>
  );
}

export function LatencyPage() {
  const [windowDays, setWindowDays] = useState<(typeof WINDOWS)[number]>(7);
  const [percentile, setPercentile] = useState<Percentile>('p50');
  const [modelId, setModelId] = useState<string>('');
  const [data, setData] = useState<LatencyResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setError(null);
    api.latency(windowDays).then(setData).catch((e: Error) => setError(e.message));
  }, [windowDays]);

  const selected: LatencyRow | null = useMemo(
    () => data?.models.find((m) => m.modelId === modelId) ?? null,
    [data, modelId],
  );
  const view = selected ?? (data ? { ...data.fleet, modelId: '', label: 'All models' } : null);
  // Labels that appear more than once get their routing prefix back, so the table never shows two
  // identically named rows with different numbers.
  const ambiguous = useMemo(() => {
    const counts = new Map<string, number>();
    for (const m of data?.models ?? []) counts.set(m.label, (counts.get(m.label) ?? 0) + 1);
    return new Set([...counts].filter(([, n]) => n > 1).map(([l]) => l));
  }, [data]);
  // What distinguishes two same-named rows: for profile-routed traffic the profile itself, since
  // that is the actual route, and otherwise the region prefix.
  const routeOf = (m: LatencyRow): string =>
    m.via === 'inference-profile' ? (m.profileName ?? m.modelId) : scopeOf(m.modelId);
  const nameOf = (m: LatencyRow): string =>
    ambiguous.has(m.label) ? `${m.label} · ${routeOf(m)}` : m.label;
  // Profile names are deployment-chosen and can be long; the picker buttons sit in a row, so they
  // get a clipped form with the full value on hover rather than a name we invented.
  const shortRoute = (m: LatencyRow): string => {
    const r = routeOf(m);
    return r.length > 16 ? `${r.slice(0, 15)}…` : r;
  };
  const segments = useMemo(
    () => (data && view ? layout(data.hops, view, percentile) : []),
    [data, view, percentile],
  );

  if (error) {
    return (
      <Panel title="Latency unavailable" desc="The CloudWatch read failed">
        <div className="muted">{error}</div>
      </Panel>
    );
  }
  if (!data || !view) return <Panel title="Model-hop latency"><div className="muted">Loading…</div></Panel>;

  const unmeasured = data.hops.filter((h) => h.status !== 'measured');

  return (
    <>
      <div className="toolbar">
        <div className="seg" aria-label="Window">
          {WINDOWS.map((w) => (
            <button key={w} className={windowDays === w ? 'active' : ''} onClick={() => setWindowDays(w)}>
              {w === 1 ? '24 hours' : `${w} days`}
            </button>
          ))}
        </div>
        <div className="seg" aria-label="Percentile">
          {PERCENTILES.map((p) => (
            <button key={p} className={percentile === p ? 'active' : ''} onClick={() => setPercentile(p)}>{p}</button>
          ))}
        </div>
        <div className="seg" aria-label="Model">
          <button className={modelId === '' ? 'active' : ''} onClick={() => setModelId('')}>All models</button>
          {data.models.slice(0, 4).map((m) => (
            <button
              key={m.modelId}
              className={modelId === m.modelId ? 'active' : ''}
              title={ambiguous.has(m.label) ? `${m.label} · ${routeOf(m)}` : m.label}
              onClick={() => setModelId(m.modelId)}>
              {m.label.split('.').pop()}{ambiguous.has(m.label) ? ` · ${shortRoute(m)}` : ''}
            </button>
          ))}
        </div>
        <span className="muted" style={{ fontSize: 12 }}>{data.source}</span>
      </div>

      <Panel
        title="Where the time goes"
        desc={`End-to-end chain for ${view.label}. Only the Bedrock hop is observable from our own telemetry; the other three are named so the gap is explicit.`}
      >
        <ChainDiagram segments={segments} percentile={percentile} />
      </Panel>

      <div className="kpi-grid">
        <Kpi
          label="Time to first byte"
          chip={
            <>
              <span className="badge">streaming only</span>
              {view.ttft.approximated ? <span className="badge">weighted</span> : null}
            </>
          }
          value={fmtMs(view.ttft[percentile])}
          accent={MEASURED}
          foot={`${view.ttft.samples ?? 0} streaming invocations · ${percentile}${APPROX_FOOT(view.ttft.approximated)}`}
        />
        <Kpi
          label="Generation (streaming tail)"
          chip={<span className="badge">derived</span>}
          value={fmtMs(view.generation[percentile])}
          accent={MEASURED_2}
          foot="end-to-end minus first byte at the same percentile — indicative, percentiles are not additive"
        />
        <Kpi
          label="End-to-end model call"
          chip={view.e2e.approximated ? <span className="badge">weighted</span> : undefined}
          value={fmtMs(view.e2e[percentile])}
          foot={`${view.e2e.samples ?? 0} invocations · ${percentile} · Bedrock service time only${APPROX_FOOT(view.e2e.approximated)}`}
        />
        <Kpi
          label="Streaming coverage"
          value={data.coverage.streamingPct === null ? '—' : `${data.coverage.streamingPct}%`}
          foot={data.coverage.note}
        />
      </div>

      <Panel title="By model" desc="Sorted by p95 end-to-end. A model with few samples has a noisy tail — read the sample count before the percentile.">
        <table className="data">
          <thead>
            <tr>
              <th>Model</th><th className="num">Invocations</th>
              <th className="num">TTFB p50</th><th className="num">TTFB p95</th>
              <th className="num">E2E p50</th><th className="num">E2E p95</th><th className="num">E2E p99</th>
            </tr>
          </thead>
          <tbody>
            {data.models.map((m) => (
              <tr key={m.modelId}>
                <td>
                  {nameOf(m)}
                  {m.via === 'inference-profile' && (
                    <span
                      className="badge"
                      style={{ marginLeft: 6 }}
                      title={
                        m.resolvedModel
                          ? `CloudWatch reported this series under inference profile ${m.modelId}; resolved to ${m.resolvedModel}.`
                          : `Inference profile ${m.modelId} routes to more than one model, so this row is not attributable to a single one.`
                      }>
                      {m.resolvedModel ? 'via profile' : 'multi-model profile'}
                    </span>
                  )}
                </td>
                <td className="num">{m.e2e.samples ?? 0}</td>
                <td className="num">{fmtMs(m.ttft.p50)}</td>
                <td className="num">{fmtMs(m.ttft.p95)}</td>
                <td className="num">{fmtMs(m.e2e.p50)}</td>
                <td className="num">{fmtMs(m.e2e.p95)}</td>
                <td className="num">{fmtMs(m.e2e.p99)}</td>
              </tr>
            ))}
            {data.models.length === 0 && (
              <tr><td colSpan={7} className="muted">No invocations in this window.</td></tr>
            )}
          </tbody>
        </table>
      </Panel>

      <Panel title="What we cannot see yet" desc="Three of the five hops need telemetry that does not exist on our side of the boundary">
        <table className="data">
          <thead><tr><th>Hop</th><th>Why it is dark</th><th>What would light it up</th></tr></thead>
          <tbody>
            {unmeasured.map((h) => (
              <tr key={h.id}>
                <td>{h.label}</td>
                <td className="muted">{h.note}</td>
                <td className="muted">{h.instrument}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>

      <Disclosure summary="Definitions & limitations">
        <p>
          <strong>Metric names.</strong> Time to first token, time per output token and end-to-end duration,
          read as percentiles, are the vocabulary the OpenTelemetry GenAI semantic conventions define and that
          gateway and observability vendors mirror. We use those names rather than inventing our own.
        </p>
        <p>
          <strong>Source and scope.</strong> {data.source}. {data.scopeNote} Window {data.window} day(s),
          read at {new Date(data.generatedAt).toISOString().slice(0, 16).replace('T', ' ')} UTC.
        </p>
        <p>
          <strong>Streaming only for first byte.</strong> {data.coverage.note} A non-streaming invocation
          publishes no first-byte metric at all, so the two sample counts are expected to differ.
        </p>
        <p>
          <strong>The generation segment is derived.</strong> It is end-to-end minus first byte at the same
          percentile. Percentiles do not add, so the segment is indicative of shape, not an exact measurement
          of any single request.
        </p>
        <p>
          <strong>How the window is aggregated.</strong> {data.percentileNote} Anything marked{' '}
          <span className="badge">weighted</span> above is that weighted mean; an unmarked percentile is exact
          for the window.
        </p>
        <p>
          <strong>No benchmark, no target.</strong> We show no “good” threshold because we hold no distribution
          to compare against, and no per-project attribution because these metrics carry no project dimension.
        </p>
        <p><strong>{data.caveat}</strong></p>
      </Disclosure>
    </>
  );
}
