import { useEffect, useState } from 'react';
import {
  AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Legend,
} from 'recharts';
import { api, UsagePoint } from '../api/client';
import { Kpi, Panel } from '../components/Layout';
import { fmtTokens, fmtAxisTokens } from '../lib/format';
import { gridProps, legendProps, MARK, role, tooltipProps, xAxisProps, yAxisProps } from '../charts/theme';

/** Token usage over time + KPI summary + Bedrock quota headroom, for the signed-in tenant. */
export function UsagePage() {
  const [points, setPoints] = useState<UsagePoint[]>([]);
  const [quota, setQuota] = useState<{ throttles: any; headroom: any[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.usage()
      // Label carries the day (MM-DD HH:00): a 7-day hourly series repeats bare clock times,
      // which read as duplicated/non-monotonic ticks (F-004).
      .then((r) => setPoints(r.points.map((p) => ({ ...p, label: `${p.timestamp.slice(5, 10)} ${p.timestamp.slice(11, 16)}` }))))
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
    // Quota panel is best-effort; don't block the page if it fails.
    api.quotas().then(setQuota).catch(() => setQuota(null));
  }, []);

  if (error) return <div className="empty"><div className="big">⚠️</div>Failed to load usage: {error}</div>;
  if (loading) return <div className="empty"><span className="spinner" /></div>;

  const totalIn = points.reduce((s, p) => s + p.inputTokens, 0);
  const totalOut = points.reduce((s, p) => s + p.outputTokens, 0);
  const totalCache = points.reduce((s, p) => s + (p.cacheReadTokens ?? 0) + (p.cacheWriteTokens ?? 0), 0);
  const totalCalls = points.reduce((s, p) => s + p.invocations, 0);

  return (
    <>
      <div className="kpi-grid">
        <Kpi label="Input tokens" value={fmtTokens(totalIn)} accent={role('input')}
             foot="last 7 days — billed input, same definition as the Cost page" />
        <Kpi label="Output tokens" value={fmtTokens(totalOut)} accent={role('output')} foot="last 7 days (hourly buckets)" />
        <Kpi label="Prompt-cache tokens" value={fmtTokens(totalCache)} accent={role('cache')}
             foot="reads + writes — quota counts these as input; billing discounts them" />
        <Kpi label="Invocations" value={totalCalls.toLocaleString()} accent="var(--accent-amber)" foot="API calls" />
      </div>

      <Panel title="Token consumption over time"
             desc="Hourly buckets over the last 7 days — billed input vs output tokens (prompt-cache traffic is shown in its own KPI above; it would dwarf both series). Which series dominates depends on the workload.">
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
        {points.length === 0 && <p className="muted">No data yet — once aggregation runs, points appear here.</p>}
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
