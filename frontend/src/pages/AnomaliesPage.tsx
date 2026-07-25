import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { Kpi, Panel } from '../components/Layout';

const sevClass = (s: string) =>
  s === 'CRITICAL' ? 'critical' : s === 'WARNING' ? 'warning' : 'info';

/** Feed of anomaly/alert events (Cost Anomaly Detection + automated response signals). */
export function AnomaliesPage() {
  const [items, setItems] = useState<any[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.anomalies().then((r) => setItems(r.anomalies)).catch((e) => setError(String(e))).finally(() => setLoading(false));
  }, []);

  if (error) return <div className="empty"><div className="big">⚠️</div>Failed to load anomalies: {error}</div>;
  if (loading) return <div className="empty"><span className="spinner" /></div>;

  const critical = items.filter((a) => a.severity === 'CRITICAL').length;
  const warning = items.filter((a) => a.severity === 'WARNING').length;

  return (
    <>
      <div className="kpi-grid">
        <Kpi label="Total alerts" value={String(items.length)} accent="var(--primary)" />
        <Kpi label="Critical" value={String(critical)} accent="var(--danger)" />
        <Kpi label="Warning" value={String(warning)} accent="var(--warning)" />
      </div>

      <Panel title="Alert feed"
             desc="Newest first — from EventBridge → automated response. Shows the most recent detections; an old top entry means no anomalies have fired since then.">
        {items.length === 0 ? (
          <div className="empty"><div className="big">✅</div>No anomalies recorded. All clear.</div>
        ) : (
          <table className="data">
            <thead>
              <tr><th>Severity</th><th>Type</th><th>Detail</th><th>Detected</th></tr>
            </thead>
            <tbody>
              {items.map((a, i) => (
                <tr key={i}>
                  <td><span className={`badge ${sevClass(a.severity)}`}>{a.severity ?? 'INFO'}</span></td>
                  <td>{a.type ?? '—'}</td>
                  <td className="muted">{a.message ?? JSON.stringify(a)}</td>
                  <td className="muted mono">{(a.detectedAt ?? a.sk ?? '').slice(0, 19).replace('T', ' ')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
    </>
  );
}
