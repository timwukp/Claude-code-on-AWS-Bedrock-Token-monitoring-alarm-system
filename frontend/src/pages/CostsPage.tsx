import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { Kpi, Panel } from '../components/Layout';
import { fmtUsd, fmtTokens } from '../lib/format';

/** Estimated spend per model + total, derived from token aggregates × rate card. */
export function CostsPage() {
  const [data, setData] = useState<{ byModel: any[]; totalEstimatedUsd: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { api.costs().then(setData).catch((e) => setError(String(e))); }, []);

  if (error) return <div className="empty"><div className="big">⚠️</div>Failed to load costs: {error}</div>;
  if (!data) return <div className="empty"><span className="spinner" /></div>;

  const totalCalls = data.byModel.reduce((s, m) => s + Number(m.invocations ?? 0), 0);
  const totalCacheRead = data.byModel.reduce((s, m) => s + Number(m.cacheReadTokens ?? 0), 0);
  const shortModel = (id: string) => id.split('/').pop() ?? id;

  return (
    <>
      <div className="kpi-grid">
        <Kpi label="Estimated spend" value={fmtUsd(data.totalEstimatedUsd)} accent="var(--primary)" foot="current window" />
        <Kpi label="Models used" value={String(data.byModel.length)} accent="var(--accent-blue)" />
        <Kpi label="Cache-read tokens" value={fmtTokens(totalCacheRead)} accent="var(--accent-green)" foot="billed at 0.1×" />
        <Kpi label="Invocations" value={totalCalls.toLocaleString()} accent="var(--accent-amber)" />
      </div>

      <Panel title="Spend by model" desc="Estimate — reconfirm against official pricing before billing">
        <table className="data">
          <thead>
            <tr>
              <th>Model</th>
              <th className="num">Input tokens</th>
              <th className="num">Output tokens</th>
              <th className="num">Cache-read</th>
              <th className="num">Est. USD</th>
            </tr>
          </thead>
          <tbody>
            {data.byModel.map((m, i) => (
              <tr key={i}>
                <td><span className="mono">{shortModel(String(m.modelId))}</span></td>
                <td className="num">{Number(m.inputTokens ?? 0).toLocaleString()}</td>
                <td className="num">{Number(m.outputTokens ?? 0).toLocaleString()}</td>
                <td className="num muted">{fmtTokens(Number(m.cacheReadTokens ?? 0))}</td>
                <td className="num"><strong>{fmtUsd(Number(m.estimatedUsd ?? 0))}</strong></td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>
    </>
  );
}
