import { useEffect, useMemo, useState } from 'react';
import { api } from '../api/client';
import { EmptyState } from '../components/EmptyState';
import { Disclosure, Kpi, Panel } from '../components/Layout';
import { useTimeRange } from '../lib/time-range';

const sevClass = (s: string) =>
  s === 'CRITICAL' ? 'critical' : s === 'WARNING' ? 'warning' : 'info';

/** Feed of anomaly/alert events (Cost Anomaly Detection + automated response signals). */
const detectedAt = (a: any): string => String(a.detectedAt ?? (typeof a.sk === 'string' ? a.sk.replace(/^ANOMALY#/, '').slice(0, 24) : ''));

export function AnomaliesPage() {
  const range = useTimeRange([7, 30, 90, 'mtd']);
  const [all, setAll] = useState<any[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.anomalies().then((r) => setAll(r.anomalies)).catch((e) => setError(String(e))).finally(() => setLoading(false));
  }, []);

  // The API returns the newest 100 detections with no window parameter; the window is applied here.
  const items = useMemo(() => all.filter((a) => detectedAt(a) >= range.fromIso), [all, range.fromIso]);
  // Everything the feed holds but the window hides. Shown on request rather than merely counted: the
  // empty state used to say "2 older detections exist outside this window" and offer no way to see
  // them — reported six times (F-PR51-006 → F-PR56R4-001). The widest window is 90 days and the API
  // keeps the newest 100 detections regardless, so anything older than 90 days is otherwise unreachable.
  const older = useMemo(() => all.filter((a) => detectedAt(a) < range.fromIso), [all, range.fromIso]);
  const olderCount = older.length;

  if (error) return <EmptyState kind="error" title="Anomalies could not be loaded" detail={error} action={{ label: 'Retry', onClick: () => location.reload() }} />;
  if (loading) return <EmptyState kind="loading" title="Loading anomalies…" />;

  const critical = items.filter((a) => a.severity === 'CRITICAL').length;
  const warning = items.filter((a) => a.severity === 'WARNING').length;

  return (
    <>
      <div className="kpi-grid">
        <Kpi label="Total alerts" value={String(items.length)} accent="var(--primary)" foot={range.label.toLowerCase()} />
        <Kpi label="Critical" value={String(critical)} accent="var(--danger)" />
        <Kpi label="Warning" value={String(warning)} accent="var(--warning)" />
      </div>

      <Panel title="Alert feed"
             desc={`Newest first, ${range.label.toLowerCase()} — from EventBridge → automated response.${olderCount > 0 ? ` ${olderCount} older detection${olderCount === 1 ? '' : 's'} outside this window.` : ''}`}>
        {items.length === 0 ? (
          <EmptyState kind="empty" icon="check"
            title={`No anomalies detected in the ${range.label.toLowerCase()}`}
            detail={olderCount > 0
              ? `${olderCount} older detection${olderCount === 1 ? '' : 's'} exist outside this window${range.window === 90 ? ' — beyond 90 days; the feed keeps the newest 100 detections overall' : ''}.`
              : 'Detectors are the aggregator’s spend-runaway guard and Cost Anomaly Detection; a detection appears here within minutes of firing.'}
            action={olderCount > 0 && range.window !== 90 ? { label: 'Show last 90 days', onClick: () => range.setWindow(90) } : { label: 'View budget guardrails', to: '/governance' }} />
        ) : <FeedTable rows={items} />}
        {olderCount > 0 && (
          <Disclosure summary={`Show ${olderCount} older detection${olderCount === 1 ? '' : 's'} — before ${range.fromIso.slice(0, 10)}${range.window === 90 ? ' (the feed keeps the newest 100 detections overall)' : ''}`}>
            <FeedTable rows={older} />
          </Disclosure>
        )}
      </Panel>
    </>
  );
}

function FeedTable({ rows }: { rows: any[] }) {
  return (
    <table className="data">
      <thead>
        <tr><th>Severity</th><th>Type</th><th>Detail</th><th>Detected</th></tr>
      </thead>
      <tbody>
        {rows.map((a, i) => (
          <tr key={i}>
            <td><span className={`badge ${sevClass(a.severity)}`}>{a.severity ?? 'INFO'}</span></td>
            <td>{a.type ?? '—'}</td>
            <td className="muted">{a.message ?? JSON.stringify(a)}</td>
            <td className="muted mono">{(a.detectedAt ?? a.sk ?? '').slice(0, 19).replace('T', ' ')}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
