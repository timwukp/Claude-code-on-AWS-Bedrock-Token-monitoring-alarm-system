import { useEffect, useState } from 'react';
import {
  AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Legend,
} from 'recharts';
import { api, UsagePoint } from '../api/client';
import { Kpi, Panel } from '../components/Layout';
import { fmtTokens } from '../lib/format';

/** Token usage over time + KPI summary, for the signed-in tenant. */
export function UsagePage() {
  const [points, setPoints] = useState<UsagePoint[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.usage()
      .then((r) => setPoints(r.points.map((p) => ({ ...p, label: p.timestamp.slice(11, 16) }))))
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, []);

  if (error) return <div className="empty"><div className="big">⚠️</div>Failed to load usage: {error}</div>;
  if (loading) return <div className="empty"><span className="spinner" /></div>;

  const totalIn = points.reduce((s, p) => s + p.inputTokens, 0);
  const totalOut = points.reduce((s, p) => s + p.outputTokens, 0);
  const totalCalls = points.reduce((s, p) => s + p.invocations, 0);

  return (
    <>
      <div className="kpi-grid">
        <Kpi label="Input tokens" value={fmtTokens(totalIn)} accent="var(--accent-blue)" foot="across window" />
        <Kpi label="Output tokens" value={fmtTokens(totalOut)} accent="var(--accent-green)" foot="across window" />
        <Kpi label="Invocations" value={totalCalls.toLocaleString()} accent="var(--accent-amber)" foot="API calls" />
        <Kpi label="Active hours" value={String(points.length)} foot="buckets with traffic" />
      </div>

      <Panel title="Token consumption over time" desc="Hourly buckets — input vs output tokens">
        <ResponsiveContainer width="100%" height={340}>
          <AreaChart data={points} margin={{ left: 4, right: 12, top: 8 }}>
            <defs>
              <linearGradient id="gIn" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#2563eb" stopOpacity={0.35} />
                <stop offset="100%" stopColor="#2563eb" stopOpacity={0.02} />
              </linearGradient>
              <linearGradient id="gOut" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#16a34a" stopOpacity={0.35} />
                <stop offset="100%" stopColor="#16a34a" stopOpacity={0.02} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="#eef2f7" vertical={false} />
            <XAxis dataKey="label" tick={{ fontSize: 12, fill: '#64748b' }} tickLine={false} axisLine={{ stroke: '#e2e8f0' }} />
            <YAxis tick={{ fontSize: 12, fill: '#64748b' }} tickLine={false} axisLine={false} tickFormatter={fmtTokens} width={48} />
            <Tooltip contentStyle={{ borderRadius: 10, border: '1px solid #e2e8f0', fontSize: 13 }} />
            <Legend iconType="circle" wrapperStyle={{ fontSize: 13, paddingTop: 8 }} />
            <Area type="monotone" dataKey="inputTokens" name="Input tokens" stroke="#2563eb" strokeWidth={2} fill="url(#gIn)" />
            <Area type="monotone" dataKey="outputTokens" name="Output tokens" stroke="#16a34a" strokeWidth={2} fill="url(#gOut)" />
          </AreaChart>
        </ResponsiveContainer>
        {points.length === 0 && <p className="muted">No data yet — once aggregation runs, points appear here.</p>}
      </Panel>
    </>
  );
}
