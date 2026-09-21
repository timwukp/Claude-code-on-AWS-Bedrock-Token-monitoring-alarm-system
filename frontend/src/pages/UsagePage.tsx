import { useEffect, useState } from 'react';
import {
  AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Legend,
} from 'recharts';
import { api, UsagePoint } from '../api/client';
import { Kpi, Panel } from '../components/Layout';
import { fmtInt, fmtTokens, fmtAxisTokens } from '../lib/format';
import { gridProps, legendProps, MARK, role, tooltipProps, xAxisProps, yAxisProps } from '../charts/theme';
import { EmptyState } from '../components/EmptyState';
import { useTimeRange } from '../lib/time-range';

/** Token usage over time + KPI summary + Bedrock quota headroom, for the signed-in tenant. */
/** Hourly points read fine over a week; past that they blur into a wall, so bucket to days. */
function bucketDaily(points: UsagePoint[]): UsagePoint[] {
  const by = new Map<string, UsagePoint>();
  for (const p of points) {
    const day = p.timestamp.slice(0, 10);
    const e = by.get(day) ?? { ...p, timestamp: `${day}T00:00:00Z`, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, invocations: 0 };
    e.inputTokens += p.inputTokens; e.outputTokens += p.outputTokens;
    e.cacheReadTokens = (e.cacheReadTokens ?? 0) + (p.cacheReadTokens ?? 0);
    e.cacheWriteTokens = (e.cacheWriteTokens ?? 0) + (p.cacheWriteTokens ?? 0);
    e.invocations += p.invocations;
    by.set(day, e);
  }
  return [...by.values()];
}

export function UsagePage() {
  const range = useTimeRange([7, 30, 90, 'mtd']);
  const [points, setPoints] = useState<UsagePoint[]>([]);
  const [quota, setQuota] = useState<{ throttles: any; headroom: any[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const daily = range.days > 14;
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api.usage(range.fromIso, range.toIso)
      // Label carries the day (MM-DD HH:00): a 7-day hourly series repeats bare clock times,
      // which read as duplicated/non-monotonic ticks (F-004). Longer windows are bucketed to days.
      .then((r) => {
        if (cancelled) return;
        const pts = daily ? bucketDaily(r.points) : r.points;
        setPoints(pts.map((p) => ({ ...p, label: daily ? p.timestamp.slice(5, 10) : `${p.timestamp.slice(5, 10)} ${p.timestamp.slice(11, 16)}` })));
        setError(null);
      })
      .catch((e) => { if (!cancelled) setError(String(e)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [range.fromIso, range.toIso, daily]);
  useEffect(() => {
    // Quota panel is best-effort and window-independent; don't block the page if it fails.
    api.quotas().then(setQuota).catch(() => setQuota(null));
  }, []);

  if (error) return <EmptyState kind="error" title="Usage could not be loaded" detail={error} action={{ label: 'Retry', onClick: () => location.reload() }} />;
  if (loading && points.length === 0) return <EmptyState kind="loading" title="Loading usage…" />;

  const totalIn = points.reduce((s, p) => s + p.inputTokens, 0);
  const totalOut = points.reduce((s, p) => s + p.outputTokens, 0);
  const totalCache = points.reduce((s, p) => s + (p.cacheReadTokens ?? 0) + (p.cacheWriteTokens ?? 0), 0);
  const totalCalls = points.reduce((s, p) => s + p.invocations, 0);

  return (
    <>
      <div className="kpi-grid">
        <Kpi label="Input tokens" value={fmtTokens(totalIn)} accent={role('input')}
             foot={`${range.label.toLowerCase()} — billed input, same definition as the Cost page`} />
        <Kpi label="Output tokens" value={fmtTokens(totalOut)} accent={role('output')} foot={`${range.label.toLowerCase()} (${daily ? 'daily' : 'hourly'} buckets)`} />
        <Kpi label="Prompt-cache tokens" value={fmtTokens(totalCache)} accent={role('cache')}
             foot="reads + writes — quota counts these as input; billing discounts them" />
        <Kpi label="Invocations" value={fmtInt(totalCalls)} accent="var(--accent-amber)" foot="API calls" />
      </div>

      <Panel title="Token consumption over time"
             desc={`${daily ? 'Daily' : 'Hourly'} buckets, ${range.label.toLowerCase()} — billed input vs output tokens (prompt-cache traffic is shown in its own KPI above; it would dwarf both series). Which series dominates depends on the workload.`}>
        <ResponsiveContainer width="100%" height={340}>
          <AreaChart data={points} margin={{ left: 4, right: 12, top: 8 }}>
            <CartesianGrid {...gridProps()} />
            <XAxis dataKey="label" {...xAxisProps()} />
            <YAxis {...yAxisProps(fmtAxisTokens)} width={48} />
            <Tooltip {...tooltipProps()} />
            <Legend {...legendProps()} wrapperStyle={{ fontSize: 13, paddingTop: 8 }} />
            <Area type="monotone" dataKey="inputTokens" name="Input tokens" stroke={role('input')} fill={role('input')} {...MARK.area} />
            <Area type="monotone" dataKey="outputTokens" name="Output tokens" stroke={role('output')} fill={role('output')} {...MARK.area} />
          </AreaChart>
        </ResponsiveContainer>
        {points.length === 0 && <EmptyState kind="empty" title={`No usage recorded in the ${range.label.toLowerCase()}`} detail="Points appear once the aggregator has processed invocation logs for this window." action={{ label: 'Show last 90 days', onClick: () => range.setWindow(90) }} />}
      </Panel>

      {quota && (
        <Panel title="Bedrock token-quota headroom"
               desc="Account-wide per-model token rate limits (HTTP 429 on breach), from CloudWatch. Counts ALL account traffic — not just this tenant's — so Used here exceeds the tenant-scoped KPIs above.">
          <div style={{ marginTop: 0, marginBottom: 12 }}>
            <div>
              <span className={`badge ${quota.throttles?.throttled ? 'critical' : 'info'}`}>
                {quota.throttles?.throttled ? `⚠ ${quota.throttles.throttledCount} requests throttled (HTTP 429)` : '✓ No throttling — zero HTTP 429s in 24h'}
              </span>
            </div>
            <div className="muted" style={{ marginTop: 6, fontSize: 12 }}>
              Unrelated: {quota.throttles?.clientErrors ?? 0} other client errors (4xx — auth/validation, not throttling) in the same window.
            </div>
          </div>
          {quota.headroom.length === 0 ? (
            <p className="muted">No per-model token quotas matched to active models yet.</p>
          ) : (
          <table className="data">
            <thead>
              <tr>
                <th>Model (quota)</th><th>Window</th>
                <th className="num">Limit (tokens)</th><th className="num">Used (this model)</th>
                <th className="num">Used %</th><th className="num">Headroom (left)</th><th>Status</th>
              </tr>
            </thead>
            <tbody>
              {quota.headroom.slice(0, 12).map((q: any, i: number) => (
                <tr key={i}>
                  <td className="mono" style={{ maxWidth: 380, overflow: 'hidden', textOverflow: 'ellipsis' }}
                      title={q.name}>{q.name.replace(/^.*tokens per (minute|day) for /i, '').trim() || q.name}</td>
                  <td>{q.window === 'minute' ? 'per minute' : 'per day'}</td>
                  <td className="num">{fmtTokens(q.limit)}</td>
                  <td className="num">{fmtTokens(q.used)}</td>
                  <td className="num">{q.usedPct}%</td>
                  <td className="num">{fmtTokens(q.remaining)}</td>
                  <td><span className={`badge ${q.status === 'critical' ? 'critical' : q.status === 'warn' ? 'warning' : 'info'}`}>{q.status}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
          )}
          <p className="muted" style={{ fontSize: 12, marginTop: 10 }}>
            <strong>Used</strong> is that model's own consumption (CloudWatch AWS/Bedrock metrics,
            by ModelId). <strong>Used %</strong> = Used ÷ Limit in the same window (per-minute vs
            the TPM limit; per-day vs the daily limit). <strong>Headroom</strong> = tokens left
            before the limit. Limits come from Service Quotas. Hover a model for its full id.
          </p>
        </Panel>
      )}
    </>
  );
}
