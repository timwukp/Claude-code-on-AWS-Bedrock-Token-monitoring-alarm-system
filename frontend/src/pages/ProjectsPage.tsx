import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { Kpi, Panel } from '../components/Layout';
import { fmtTokens, fmtUsd } from '../lib/format';

/**
 * Usage attributed to projects/users. Attribution comes from Bedrock requestMetadata tags
 * (user_id, project_id) joined to a customer-supplied project mapping. See docs/ATTRIBUTION.md.
 */
/** Athena result rows → table rows (row 0 is the header). */
function mapAthenaProjectRows(rows: any[]): any[] {
  return rows.slice(1).map((r) => {
    const c = r?.Data ?? [];
    return {
      projectName: c[0]?.VarCharValue ?? 'untagged',
      costCenter: c[1]?.VarCharValue ?? '—',
      users: Number(c[2]?.VarCharValue ?? 0),
      tokens: Number(c[3]?.VarCharValue ?? 0),
      estimatedUsd: Math.round(Number(c[4]?.VarCharValue ?? 0) * 1e6) / 1e6,
    };
  });
}

export function ProjectsPage() {
  const [rows, setRows] = useState<any[]>([]);
  const [source, setSource] = useState<'fast' | 'full'>('fast');
  const [servedFrom, setServedFrom] = useState<string>('');
  const [apiTotalTokens, setApiTotalTokens] = useState<number | null>(null);
  const [apiTotalUsd, setApiTotalUsd] = useState<number | null>(null);
  const [apiTotalCost, setApiTotalCost]     = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    if (source === 'fast') {
      api.projects('fast')
        .then((r) => {
          if (cancelled) return;
          setRows(r.projects ?? []);
          setServedFrom(r.source ?? 'dynamodb');
          setApiTotalTokens(r.totalTokens != null ? Number(r.totalTokens) : null);
          setApiTotalUsd(r.totalEstimatedUsd != null ? Number(r.totalEstimatedUsd) : null);
        })
        .catch((e) => { if (!cancelled) setError(String(e)); })
        .finally(() => { if (!cancelled) setLoading(false); });
    } else {
      // Full (Athena) view runs ASYNC — start the query, then poll (F-002). The scan takes
      // 15-30s on real data, longer than any sane synchronous API timeout; the old sync path
      // hit the Lambda timeout mid-poll and the browser surfaced status 0 / "Failed to fetch".
      (async () => {
        const { id } = await api.startQuery('byProject', 90);
        const deadline = Date.now() + 75_000;
        for (;;) {
          if (cancelled) return;
          const res = await api.pollQuery(id);
          if (res.state === 'SUCCEEDED') {
            if (cancelled) return;
            setRows(mapAthenaProjectRows(res.rows ?? []));
            setServedFrom('athena (async)');
            setApiTotalTokens(null);
            setApiTotalUsd(null);
            setLoading(false);
            return;
          }
          if (res.state === 'FAILED' || res.state === 'CANCELLED') {
            throw new Error('Athena query failed — most often the project_mapping table has not been created yet (see docs/ATTRIBUTION.md)');
          }
          if (Date.now() > deadline) throw new Error('Athena query still running after 75s — use Retry in a moment');
          await new Promise((r) => setTimeout(r, 2500));
        }
      })().catch((e) => {
        if (!cancelled) { setError(String(e).replace(/^Error: /, '')); setLoading(false); }
      });
    }
    return () => { cancelled = true; };
  }, [source, refreshKey]);

  // Keep the page frame (toggle stays clickable) while a source loads; only the table area spins.
  const bodyLoading = loading;

  const totalTokens = rows.reduce((s, r) => s + (Number(r.tokens) || 0), 0);
  const totalCost   = rows.reduce((s, r) => s + (Number(r.estimatedUsd) || 0), 0);

  return (
    <>
      <div className="kpi-grid">
        <Kpi label="Projects tracked" value={String(rows.length)} accent="var(--primary)" />
        <Kpi label="Total tokens" value={fmtTokens(totalTokens)} accent="var(--accent-blue)" />
        <Kpi label="Total est. cost" value={fmtUsd(totalCost)} accent="var(--accent-green)"
             foot="per-model rates — same math as the Cost page" />
      </div>

      <Panel title="Usage by project"
             desc="Attributed via requestMetadata tags + project mapping (CSV). Fast = pre-aggregated DynamoDB rollups. Full = Athena scan over raw invocation logs joined to the name mapping (untagged traffic COALESCEs into 'untagged'). The two pipelines ingest at different times, so totals can differ slightly.">
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14 }}>
          <div style={{ display: 'inline-flex', border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
            {(['fast', 'full'] as const).map((s) => (
              <button key={s} onClick={() => setSource(s)}
                style={{
                  padding: '6px 14px', fontSize: 13, border: 'none', cursor: 'pointer',
                  background: source === s ? 'var(--primary)' : '#fff',
                  color: source === s ? '#fff' : 'var(--text-dim)', fontWeight: source === s ? 600 : 400,
                }}>
                {s === 'fast' ? 'Fast (DynamoDB)' : 'Full (Athena + names)'}
              </button>
            ))}
          </div>
          {servedFrom && <span className="muted" style={{ fontSize: 12 }}>served from: <strong>{servedFrom}</strong></span>}
        </div>
        {bodyLoading ? (
          <div className="empty"><span className="spinner" /> <span className="muted">loading {source === 'fast' ? 'DynamoDB rollups' : 'Athena scan (typically 15-30s — running async)'}…</span></div>
        ) : error ? (
          <div className="empty"><div className="big">⚠️</div>Failed to load: {error}{' '}
            <button onClick={() => { setError(null); setRefreshKey((k) => k + 1); }}
                    style={{ marginLeft: 10 }}>Retry</button>
          </div>
        ) : rows.length === 0 ? (
          <div className="empty">
            <div className="big">🗂️</div>
            No project-tagged usage yet.<br />
            <span className="muted">
              Have your application pass <code>requestMetadata: {'{ project_id, user_id }'}</code> on
              Bedrock calls, and upload a project-mapping CSV. See docs/ATTRIBUTION.md.
            </span>
          </div>
        ) : (
          <table className="data">
            <thead>
              <tr>
                <th>Project</th><th>Cost center</th>
                <th className="num">Users</th><th className="num">Tokens</th><th className="num">Est. USD</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i}>
                  <td><strong>{r.projectName ?? r.projectId}</strong></td>
                  <td className="muted">{r.costCenter ?? '—'}</td>
                  <td className="num">{r.users ?? '—'}</td>
                  <td className="num">{fmtTokens(Number(r.tokens ?? 0))}</td>
                  <td className="num"><strong>{fmtUsd(Number(r.estimatedUsd ?? 0))}</strong></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
    </>
  );
}
