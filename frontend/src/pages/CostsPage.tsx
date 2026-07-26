import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { Kpi, Panel } from '../components/Layout';
import { fmtUsd, fmtTokens } from '../lib/format';

/** Estimated spend per model + total, derived from token aggregates × rate card. */
export function CostsPage() {
  const [data, setData] = useState<{ byModel: any[]; totalEstimatedUsd: number; totalCacheSavingsUsd?: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sortDesc, setSortDesc] = useState<boolean | null>(null);

  useEffect(() => { api.costs().then(setData).catch((e) => setError(String(e))); }, []);

  if (error) return <div className="empty"><div className="big">⚠️</div>Failed to load costs: {error}</div>;
  if (!data) return <div className="empty"><span className="spinner" /></div>;
  if (data.byModel.length === 0) return <div className="empty"><div className="big">⚠️</div>No cost data returned — the costs API reported an empty rollup. Check the costs aggregation backend.</div>;

  const totalCacheRead = data.byModel.reduce((s, m) => s + Number(m.cacheReadTokens ?? 0), 0);
  const totalEstimatedUsd = data.byModel.reduce((s, m) => s + Number(m.estimatedUsd ?? 0), 0);
  const savings = Number(data.totalCacheSavingsUsd ?? 0);
  const beforeCaching = totalEstimatedUsd + savings;
  const savedPct = beforeCaching > 0 ? Math.round((savings / beforeCaching) * 100) : 0;
  const shortModel = (id: string) => id.split('/').pop() ?? id;
  const rows = sortDesc == null ? data.byModel
    : [...data.byModel].sort((a, b) => (Number(b.estimatedUsd ?? 0) - Number(a.estimatedUsd ?? 0)) * (sortDesc ? 1 : -1));

  return (
    <>
      <div className="kpi-grid">
        <Kpi label="Estimated spend" value={fmtUsd(totalEstimatedUsd)} accent="var(--primary)" foot="all-time rollup · token-based estimate" />
        <Kpi label="Saved by prompt caching" value={fmtUsd(savings)} accent="var(--accent-green)"
             foot={`${savedPct}% lower than without caching`} />
        <Kpi label="Models used" value={String(data.byModel.length)} accent="var(--accent-blue)" />
        <Kpi label="Cache-read tokens" value={fmtTokens(totalCacheRead)} accent="var(--accent-amber)" foot="billed at 0.1×" />
      </div>

      <Panel title="Spend by model" desc="Estimate — reconfirm against official pricing before billing">
        <table className="data">
          <thead>
            <tr>
              <th>Model</th>
              <th className="num">Input tokens</th>
              <th className="num">Output tokens</th>
              <th className="num">Cache-read</th>
              <th className="num">Cache savings</th>
              <th className="num" style={{ cursor: 'pointer', userSelect: 'none' }}
                  title="Click to sort"
                  onClick={() => setSortDesc((d) => (d == null ? true : !d))}>
                Est. USD {sortDesc == null ? '' : sortDesc ? '↓' : '↑'}
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((m, i) => (
              <tr key={i}>
                <td><span className="mono">{shortModel(String(m.modelId))}</span></td>
                <td className="num">{Number(m.inputTokens ?? 0).toLocaleString()}</td>
                <td className="num">{Number(m.outputTokens ?? 0).toLocaleString()}</td>
                <td className="num muted">{fmtTokens(Number(m.cacheReadTokens ?? 0))}</td>
                <td className="num" style={{ color: 'var(--accent-green)' }}>{fmtUsd(Number(m.cacheSavingsUsd ?? 0))}</td>
                <td className="num"><strong>{fmtUsd(Number(m.estimatedUsd ?? 0))}</strong></td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>
    </>
  );
}
