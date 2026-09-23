import { useEffect, useMemo, useState } from 'react';
import { api, OverviewResponse } from '../api/client';
import { EmptyState } from '../components/EmptyState';
import { KpiTile } from '../components/KpiTile';
import { Panel } from '../components/Layout';
import { fmtUsd, fmtTokens } from '../lib/format';
import { mergeModelRows } from '../lib/model-names';
import { useTimeRange } from '../lib/time-range';

type ModelRow = OverviewResponse['byModel'][number];
interface MergedRow { canonical: string; friendly: string; regions: string[]; ids: string[]; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheSavingsUsd: number | null; estimatedUsd: number }
interface AllTime { byModel: { modelId: string; estimatedUsd?: number }[]; totalEstimatedUsd: number }

const ZERO_COST_THRESHOLD = 0.01;
type SortKey = 'estimatedUsd' | 'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheSavingsUsd';

/**
 * Estimated spend per model for the selected time range, from the same PROJDAY rollups and rate card
 * as Overview and By project, so the three pages reconcile. Bedrock meters one model under several ids
 * (`us.`, `global.`, bare) — the table merges them into one row with a region chip and keeps the raw ids
 * as a secondary line. Rows that cost less than a cent are folded behind a toggle. The all-time figure
 * stays as a footer line from `/v1/costs`.
 */
export function CostsPage() {
  const range = useTimeRange([7, 30, 90, 'mtd']);
  const [ov, setOv] = useState<OverviewResponse | null>(null);
  const [allTime, setAllTime] = useState<AllTime | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'estimatedUsd', dir: -1 });
  const [showZero, setShowZero] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setOv(null);
    api.overview(range.window).then((d) => { if (!cancelled) { setOv(d); setError(null); } }).catch((e) => { if (!cancelled) setError(String(e)); });
    return () => { cancelled = true; };
  }, [range.window]);
  useEffect(() => { api.costs().then((d) => setAllTime(d as AllTime)).catch(() => setAllTime(null)); }, []);

  // Older API builds do not return cacheSavingsUsd; the column then reads "—" rather than a false zero.
  const savingsKnown = Boolean(ov && ov.byModel.every((m) => typeof m.cacheSavingsUsd === 'number'));

  const merged: MergedRow[] = useMemo(() => {
    if (!ov) return [];
    const sum = (rows: ModelRow[], k: 'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'estimatedUsd') => rows.reduce((s, r) => s + Number(r[k] ?? 0), 0);
    return mergeModelRows(ov.byModel.map((m) => ({ ...m, modelId: String(m.modelId).split('/').pop() ?? String(m.modelId) })))
      .map((g) => ({
        canonical: g.canonical, friendly: g.friendly, regions: g.regions, ids: g.rows.map((r) => r.modelId),
        inputTokens: sum(g.rows, 'inputTokens'), outputTokens: sum(g.rows, 'outputTokens'), cacheReadTokens: sum(g.rows, 'cacheReadTokens'),
        estimatedUsd: sum(g.rows, 'estimatedUsd'),
        cacheSavingsUsd: savingsKnown ? g.rows.reduce((s, r) => s + Number(r.cacheSavingsUsd ?? 0), 0) : null,
      }));
  }, [ov, savingsKnown]);

  if (error) return <EmptyState kind="error" title="Costs could not be loaded" detail={error} action={{ label: 'Retry', onClick: () => location.reload() }} />;
  if (!ov) return <EmptyState kind="loading" title={`Loading costs for the ${range.label.toLowerCase()}…`} />;

  const windowLabel = range.label.toLowerCase();
  const compare = `vs ${ov.window.priorFrom.slice(5)} – ${ov.window.priorTo.slice(5)}`;
  const totalEstimatedUsd = ov.spend.currentUsd;
  const totalCacheRead = merged.reduce((s, r) => s + r.cacheReadTokens, 0);
  const savings = savingsKnown ? merged.reduce((s, r) => s + (r.cacheSavingsUsd ?? 0), 0) : null;
  const savedPct = savings != null && totalEstimatedUsd + savings > 0 ? Math.round((savings / (totalEstimatedUsd + savings)) * 100) : null;
  const partial = ov.coverage.partial ? { tone: 'neutral' as const, text: 'partial history' } : undefined;

  const significant = merged.filter((r) => r.estimatedUsd >= ZERO_COST_THRESHOLD);
  const zeroRows = merged.filter((r) => r.estimatedUsd < ZERO_COST_THRESHOLD);
  const visible = [...(showZero ? merged : significant)].sort((a, b) => sort.dir * ((a[sort.key] ?? 0) - (b[sort.key] ?? 0)));
  const toggleSort = (key: SortKey) => setSort((s) => (s.key === key ? { key, dir: (s.dir * -1) as 1 | -1 } : { key, dir: -1 }));
  const caret = (key: SortKey) => (sort.key === key ? (sort.dir === -1 ? ' ▾' : ' ▴') : '');
  const ariaSort = (key: SortKey): 'ascending' | 'descending' | 'none' => (sort.key === key ? (sort.dir === -1 ? 'descending' : 'ascending') : 'none');
  const sum = (k: Exclude<SortKey, 'cacheSavingsUsd'>) => visible.reduce((s, r) => s + r[k], 0);
  const sumSavings = savingsKnown ? visible.reduce((s, r) => s + (r.cacheSavingsUsd ?? 0), 0) : null;
  const usdOrDash = (v: number | null) => (v == null ? <span className="muted" aria-label="not available">—</span> : fmtUsd(v));

  // Rows are rounded per model; their sum can miss the window total by a cent. Say so rather than let a reader hunt for it.
  const centGap = Math.round(Math.abs(sum('estimatedUsd') - totalEstimatedUsd) * 100);
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const footer = (allTime
    ? `All time: ${fmtUsd(allTime.totalEstimatedUsd)} across ${allTime.byModel.length} model ids · the same rate card prices the By project and Overview pages, so their totals reconcile with this one.`
    : 'All-time total unavailable — the costs endpoint did not respond.')
    + (centGap > 0 ? ` The shown rows sum to ${fmtUsd(sum('estimatedUsd'))}, ${plural(centGap, 'cent')} from the tile — per-model rounding${!showZero && zeroRows.length ? ` and ${plural(zeroRows.length, 'folded model')} below $${ZERO_COST_THRESHOLD.toFixed(2)}` : ''}.` : '');

  return (
    <>
      <div className="kpi-grid">
        <KpiTile label="Estimated spend" helpId="cost.estimated-spend" accent="var(--primary)"
          value={fmtUsd(totalEstimatedUsd)}
          delta={ov.spend.deltaPct != null ? { value: ov.spend.deltaPct, unit: 'pct', compareLabel: compare, goodDirection: 'down' } : undefined}
          sparkline={ov.spend.daily.map((d) => d.usd)}
          definition={`${windowLabel} · token-based estimate${ov.spend.deltaPct == null && ov.spend.priorUsd === 0 ? ' · no prior-period data to compare' : ''}`}
          status={partial} />
        <KpiTile label="Saved by prompt caching" helpId="cost.cache-savings" accent="var(--accent-green)"
          value={savings != null ? fmtUsd(savings) : '—'}
          definition={savings != null
            ? `${windowLabel} · ${savedPct}% lower than without caching`
            : 'not available for this time range until the API is redeployed with per-window cache savings'} />
        <KpiTile label="Models used" helpId="cost.models-used" accent="var(--accent-blue)"
          value={String(merged.length)}
          definition={`${windowLabel} · ${merged.length !== ov.byModel.length ? `${ov.byModel.length} ids — regional variants of one model merged` : 'distinct model ids'}`} />
        <KpiTile label="Cache-read tokens" helpId="cost.cache-read-tokens" accent="var(--accent-amber)"
          value={fmtTokens(totalCacheRead)} definition={`${windowLabel} · billed at 0.1×`} />
      </div>

      <Panel title="Spend by model" helpId="cost.estimated-spend"
             desc={`${range.label} · estimate — reconfirm against official pricing before billing · ${significant.length} models above $${ZERO_COST_THRESHOLD.toFixed(2)}${zeroRows.length ? `, ${zeroRows.length} below` : ''}${ov.coverage.partial && ov.coverage.firstDayWithData ? ` · rollups begin ${ov.coverage.firstDayWithData}` : ''}`}>
        {merged.length === 0 ? (
          <EmptyState kind="empty" title={`No priced usage in the ${windowLabel}`}
            detail="No model recorded tokens in this time range. Widen the range, or check the ingestion pipeline if usage was expected."
            action={{ label: 'View usage', to: `/usage?window=${range.window}` }} />
        ) : (
          <table className="data">
            <thead>
              <tr>
                <th>Model</th>
                <th className="num" aria-sort={ariaSort('inputTokens')}><button className="th-sort" onClick={() => toggleSort('inputTokens')}>Input tokens{caret('inputTokens')}</button></th>
                <th className="num" aria-sort={ariaSort('outputTokens')}><button className="th-sort" onClick={() => toggleSort('outputTokens')}>Output tokens{caret('outputTokens')}</button></th>
                <th className="num" aria-sort={ariaSort('cacheReadTokens')}><button className="th-sort" onClick={() => toggleSort('cacheReadTokens')}>Cache-read{caret('cacheReadTokens')}</button></th>
                <th className="num" aria-sort={ariaSort('cacheSavingsUsd')}><button className="th-sort" onClick={() => toggleSort('cacheSavingsUsd')} disabled={!savingsKnown}>Cache savings (USD){caret('cacheSavingsUsd')}</button></th>
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
                  <td className="num">{usdOrDash(m.cacheSavingsUsd)}</td>
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
                <td className="num">{usdOrDash(sumSavings)}</td>
                <td className="num"><strong>{fmtUsd(sum('estimatedUsd'))}</strong></td>
              </tr>
            </tfoot>
          </table>
        )}
        {zeroRows.length > 0 && (
          <button className="btn-sm" style={{ marginTop: 12 }} onClick={() => setShowZero((v) => !v)} aria-expanded={showZero}>
            {showZero ? 'Hide' : 'Show'} {plural(zeroRows.length, 'model')} below ${ZERO_COST_THRESHOLD.toFixed(2)}
          </button>
        )}
        <p className="muted" style={{ fontSize: 12, marginTop: 12, marginBottom: 0 }}>{footer}</p>
      </Panel>
    </>
  );
}
