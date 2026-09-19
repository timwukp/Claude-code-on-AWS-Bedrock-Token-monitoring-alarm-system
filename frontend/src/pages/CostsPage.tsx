import { useEffect, useMemo, useState } from 'react';
import { api } from '../api/client';
import { EmptyState } from '../components/EmptyState';
import { Kpi, Panel } from '../components/Layout';
import { fmtUsd, fmtTokens } from '../lib/format';
import { mergeModelRows } from '../lib/model-names';

interface ModelCostRow { modelId: string; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheSavingsUsd: number; estimatedUsd: number }
interface MergedRow { canonical: string; friendly: string; regions: string[]; ids: string[]; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheSavingsUsd: number; estimatedUsd: number }

const ZERO_COST_THRESHOLD = 0.01;
type SortKey = 'estimatedUsd' | 'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheSavingsUsd';

/**
 * Estimated spend per model + total, derived from token aggregates × rate card.
 * Bedrock meters one model under several ids (`us.`, `global.`, bare) — the table merges them into one
 * row with a region chip and shows a friendly name, keeping the raw ids as a secondary line so they
 * stay searchable. Rows that cost less than a cent are folded behind a toggle.
 */
export function CostsPage() {
  const [data, setData] = useState<{ byModel: ModelCostRow[]; totalEstimatedUsd: number; totalCacheSavingsUsd?: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'estimatedUsd', dir: -1 });
  const [showZero, setShowZero] = useState(false);

  useEffect(() => { api.costs().then((d) => setData(d as typeof data)).catch((e) => setError(String(e))); }, []);

  const merged: MergedRow[] = useMemo(() => {
    if (!data) return [];
    return mergeModelRows(data.byModel.map((m) => ({ ...m, modelId: String(m.modelId).split('/').pop() ?? String(m.modelId) })))
      .map((g) => ({
        canonical: g.canonical, friendly: g.friendly, regions: g.regions, ids: g.rows.map((r) => r.modelId),
        inputTokens: g.rows.reduce((s, r) => s + Number(r.inputTokens ?? 0), 0),
        outputTokens: g.rows.reduce((s, r) => s + Number(r.outputTokens ?? 0), 0),
        cacheReadTokens: g.rows.reduce((s, r) => s + Number(r.cacheReadTokens ?? 0), 0),
        cacheSavingsUsd: g.rows.reduce((s, r) => s + Number(r.cacheSavingsUsd ?? 0), 0),
        estimatedUsd: g.rows.reduce((s, r) => s + Number(r.estimatedUsd ?? 0), 0),
      }));
  }, [data]);

  if (error) return <EmptyState kind="error" title="Costs could not be loaded" detail={error} action={{ label: 'Retry', onClick: () => location.reload() }} />;
  if (!data) return <EmptyState kind="loading" title="Loading costs…" />;
  if (data.byModel.length === 0) return <EmptyState kind="empty" title="No cost data yet" detail="The costs API returned an empty rollup — the aggregator has not priced any usage. Check the ingestion pipeline." action={{ label: 'View usage', to: '/usage' }} />;

  const totalCacheRead = data.byModel.reduce((s, m) => s + Number(m.cacheReadTokens ?? 0), 0);
  const totalEstimatedUsd = Number(data.totalEstimatedUsd ?? data.byModel.reduce((s, m) => s + Number(m.estimatedUsd ?? 0), 0));
  const savings = Number(data.totalCacheSavingsUsd ?? 0);
  const beforeCaching = totalEstimatedUsd + savings;
  const savedPct = beforeCaching > 0 ? Math.round((savings / beforeCaching) * 100) : 0;

  const significant = merged.filter((r) => r.estimatedUsd >= ZERO_COST_THRESHOLD);
  const zeroRows = merged.filter((r) => r.estimatedUsd < ZERO_COST_THRESHOLD);
  const visible = [...(showZero ? merged : significant)].sort((a, b) => sort.dir * (a[sort.key] - b[sort.key]));
  const toggleSort = (key: SortKey) => setSort((s) => (s.key === key ? { key, dir: (s.dir * -1) as 1 | -1 } : { key, dir: -1 }));
  const caret = (key: SortKey) => (sort.key === key ? (sort.dir === -1 ? ' ▾' : ' ▴') : '');
  const ariaSort = (key: SortKey): 'ascending' | 'descending' | 'none' => (sort.key === key ? (sort.dir === -1 ? 'descending' : 'ascending') : 'none');
  const sum = (k: keyof MergedRow) => visible.reduce((s, r) => s + Number(r[k] ?? 0), 0);

  return (
    <>
      <div className="kpi-grid">
        <Kpi label="Estimated spend" value={fmtUsd(totalEstimatedUsd)} accent="var(--primary)" foot="all-time rollup · token-based estimate" />
        <Kpi label="Saved by prompt caching" value={fmtUsd(savings)} accent="var(--accent-green)"
             foot={`${savedPct}% lower than without caching`} />
        <Kpi label="Models used" value={String(merged.length)} accent="var(--accent-blue)"
             foot={merged.length !== data.byModel.length ? `${data.byModel.length} ids — regional variants of one model merged` : 'distinct model ids'} />
        <Kpi label="Cache-read tokens" value={fmtTokens(totalCacheRead)} accent="var(--accent-amber)" foot="billed at 0.1×" />
      </div>

      <Panel title="Spend by model" helpId="cost.estimated-spend"
             desc={`Estimate — reconfirm against official pricing before billing · ${significant.length} models above $${ZERO_COST_THRESHOLD.toFixed(2)}${zeroRows.length ? `, ${zeroRows.length} below` : ''}`}>
        <table className="data">
          <thead>
            <tr>
              <th>Model</th>
              <th className="num" aria-sort={ariaSort('inputTokens')}><button className="th-sort" onClick={() => toggleSort('inputTokens')}>Input tokens{caret('inputTokens')}</button></th>
              <th className="num" aria-sort={ariaSort('outputTokens')}><button className="th-sort" onClick={() => toggleSort('outputTokens')}>Output tokens{caret('outputTokens')}</button></th>
              <th className="num" aria-sort={ariaSort('cacheReadTokens')}><button className="th-sort" onClick={() => toggleSort('cacheReadTokens')}>Cache-read{caret('cacheReadTokens')}</button></th>
              <th className="num" aria-sort={ariaSort('cacheSavingsUsd')}><button className="th-sort" onClick={() => toggleSort('cacheSavingsUsd')}>Cache savings (USD){caret('cacheSavingsUsd')}</button></th>
              <th className="num" aria-sort={ariaSort('estimatedUsd')}><button className="th-sort" onClick={() => toggleSort('estimatedUsd')}>Est. cost (USD){caret('estimatedUsd')}</button></th>
            </tr>
          </thead>
          <tbody>
            {visible.map((m) => (
              <tr key={m.canonical}>
                <td>
                  <div className="model-name">
                    {m.friendly}
                    {m.regions.map((r) => <span key={r} className="badge neutral region-chip">{r}</span>)}
                  </div>
                  <div className="mono muted model-id">{m.ids.join(' · ')}</div>
                </td>
                <td className="num">{fmtTokens(m.inputTokens)}</td>
                <td className="num">{fmtTokens(m.outputTokens)}</td>
                <td className="num muted">{fmtTokens(m.cacheReadTokens)}</td>
                <td className="num">{fmtUsd(m.cacheSavingsUsd)}</td>
                <td className="num"><strong>{fmtUsd(m.estimatedUsd)}</strong></td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="total-row">
              <td>Total{!showZero && zeroRows.length ? <span className="muted"> (shown rows)</span> : ''}</td>
              <td className="num">{fmtTokens(sum('inputTokens'))}</td>
              <td className="num">{fmtTokens(sum('outputTokens'))}</td>
              <td className="num muted">{fmtTokens(sum('cacheReadTokens'))}</td>
              <td className="num">{fmtUsd(sum('cacheSavingsUsd'))}</td>
              <td className="num"><strong>{fmtUsd(sum('estimatedUsd'))}</strong></td>
            </tr>
          </tfoot>
        </table>
        {zeroRows.length > 0 && (
          <button className="btn-sm" style={{ marginTop: 12 }} onClick={() => setShowZero((v) => !v)} aria-expanded={showZero}>
            {showZero ? `Hide ${zeroRows.length} models below $${ZERO_COST_THRESHOLD.toFixed(2)}` : `Show ${zeroRows.length} models below $${ZERO_COST_THRESHOLD.toFixed(2)}`}
          </button>
        )}
        <p className="muted" style={{ fontSize: 12, marginTop: 12, marginBottom: 0 }}>
          All time: {fmtUsd(totalEstimatedUsd)} across {data.byModel.length} model ids · the same rate card prices the By project and Overview pages, so their totals reconcile with this one.
        </p>
      </Panel>
    </>
  );
}
