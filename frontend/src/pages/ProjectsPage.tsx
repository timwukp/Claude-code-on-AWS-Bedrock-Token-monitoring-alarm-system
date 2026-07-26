import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { Kpi, Panel } from '../components/Layout';
import { fmtTokens, fmtUsd } from '../lib/format';

/**
 * Usage attributed to projects/users. Attribution comes from Bedrock requestMetadata tags
 * (user_id, project_id) joined to a customer-supplied project mapping. See docs/ATTRIBUTION.md.
 */
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
    setLoading(true);
    setError(null);
    api.projects(source)
      .then((r) => {
        setRows(r.projects ?? []);
        setServedFrom(r.source ?? (source === 'fast' ? 'dynamodb' : 'athena'));
        setApiTotalTokens(r.totalTokens != null ? Number(r.totalTokens) : null);
        setApiTotalUsd(r.totalEstimatedUsd != null ? Number(r.totalEstimatedUsd) : null);
      })
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, [source, refreshKey]);

  if (loading) return <div className="empty"><span className="spinner" /></div>;

  const totalTokens = rows.reduce((s, r) => s + (Number(r.tokens) || 0), 0);
  const totalCost   = rows.reduce((s, r) => s + (Number(r.estimatedUsd) || 0), 0);

  return (
    <>
      <div className="kpi-grid">
        <Kpi label="Projects tracked" value={String(rows.length)} accent="var(--primary)" />
        <Kpi label="Total tokens" value={fmtTokens(apiTotalTokens ?? totalTokens)} accent="var(--accent-blue)" />
        <Kpi label="Total est. cost" value={fmtUsd(apiTotalUsd ?? totalCost)} accent="var(--accent-green)"
             foot={apiTotalUsd != null ? 'per-model rates — same math as the Cost page' : 'uniform reference rates'} />
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
        {error ? (
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
