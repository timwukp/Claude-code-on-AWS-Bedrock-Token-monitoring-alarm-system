import { useEffect, useMemo, useState } from 'react';
import { api, OverviewResponse } from '../api/client';
import { EmptyState } from '../components/EmptyState';
import { KpiTile } from '../components/KpiTile';
import { Panel } from '../components/Layout';
import { fmtUsd, fmtTokens } from '../lib/format';
import { countModelIds, mergeModelRows } from '../lib/model-names';
import { useTimeRange } from '../lib/time-range';

type ModelRow = OverviewResponse['byModel'][number];
interface MergedRow { canonical: string; friendly: string; regions: string[]; ids: string[]; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; cacheSavingsUsd: number | null; cacheNetUsd: number | null; cacheReadUsd: number | null; cacheWriteUsd: number | null; estimatedUsd: number }
interface AllTime { byModel: { modelId: string; estimatedUsd?: number }[]; totalEstimatedUsd: number }
// One definition of "model" and "id" for the tile and the footer: rows merged by canonical model after ARN→id
// normalisation (qa F-PR66-001: the window said 34 ids, the all-time footer 28; F-PR66-006/F-PR67-001: a row
// listed the same id twice because the ARN and the bare id were counted as two).
const modelCounts = (rows: readonly { modelId: string }[]) => { const m = mergeModelRows(rows); return { models: m.length, ids: countModelIds(m) }; };

const ZERO_COST_THRESHOLD = 0.01;
type SortKey = 'estimatedUsd' | 'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheWriteTokens' | 'cacheSavingsUsd' | 'cacheReadUsd' | 'cacheWriteUsd';

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
  const [widest, setWidest] = useState<OverviewResponse | null>(null);
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
  // The widest selectable window is fetched once, whatever the selection, so the all-time union is
  // window-independent and never smaller than any window's tile (qa F-PR69-005).
  useEffect(() => { api.overview(90).then(setWidest).catch(() => setWidest(null)); }, []);

  // Older API builds do not return cacheSavingsUsd (pre feature-27) or the two cache dollar lines (pre feature-36);
  // those columns then read "—" rather than a false zero.
  const savingsKnown = Boolean(ov && ov.byModel.every((m) => typeof m.cacheSavingsUsd === 'number'));
  const cacheUsdKnown = Boolean(ov && ov.byModel.every((m) => typeof m.cacheReadUsd === 'number' && typeof m.cacheWriteUsd === 'number'));
  // A row with no cache traffic has a net of exactly 0 even when the API leaves the field out, and a
  // numeric string still counts as a number. One such row must not blank the tile for the whole range.
  const hasNet = (m: ModelRow) => m.cacheNetUsd != null && Number.isFinite(Number(m.cacheNetUsd));
  const noCache = (m: ModelRow) => Number(m.cacheReadTokens ?? 0) + Number(m.cacheWriteTokens ?? 0) === 0;
  const netKnown = Boolean(ov && ov.byModel.length > 0 && ov.byModel.some(hasNet)
    && ov.byModel.every((m) => hasNet(m) || noCache(m)));

  const merged: MergedRow[] = useMemo(() => {
    if (!ov) return [];
    const sum = (rows: ModelRow[], k: 'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheWriteTokens' | 'estimatedUsd') => rows.reduce((s, r) => s + Number(r[k] ?? 0), 0);
    return mergeModelRows(ov.byModel)
      .map((g) => ({
        canonical: g.canonical, friendly: g.friendly, regions: g.regions, ids: g.ids,
        inputTokens: sum(g.rows, 'inputTokens'), outputTokens: sum(g.rows, 'outputTokens'), cacheReadTokens: sum(g.rows, 'cacheReadTokens'),
        cacheWriteTokens: sum(g.rows, 'cacheWriteTokens'), estimatedUsd: sum(g.rows, 'estimatedUsd'),
        cacheSavingsUsd: savingsKnown ? g.rows.reduce((s, r) => s + Number(r.cacheSavingsUsd ?? 0), 0) : null,
        cacheReadUsd: cacheUsdKnown ? g.rows.reduce((s, r) => s + Number(r.cacheReadUsd ?? 0), 0) : null,
        cacheWriteUsd: cacheUsdKnown ? g.rows.reduce((s, r) => s + Number(r.cacheWriteUsd ?? 0), 0) : null,
        cacheNetUsd: netKnown ? g.rows.reduce((s, r) => s + Number(r.cacheNetUsd ?? 0), 0) : null,
      }));
  }, [ov, savingsKnown, cacheUsdKnown, netKnown]);

  if (error) return <EmptyState kind="error" title="Costs could not be loaded" detail={error} action={{ label: 'Retry', onClick: () => location.reload() }} />;
  if (!ov) return <EmptyState kind="loading" title={`Loading costs for the ${range.label.toLowerCase()}…`} />;

  const windowLabel = range.label.toLowerCase();
  const compare = `vs ${ov.window.priorFrom.slice(5)} – ${ov.window.priorTo.slice(5)}`;
  const totalEstimatedUsd = ov.spend.currentUsd;
  const totalCacheRead = merged.reduce((s, r) => s + r.cacheReadTokens, 0);
  const savings = savingsKnown ? merged.reduce((s, r) => s + (r.cacheSavingsUsd ?? 0), 0) : null;
  // Net = read savings − write premium. Before feature-37 the tile showed the gross read saving and called it "saved".
  const net = netKnown ? merged.reduce((s, r) => s + (r.cacheNetUsd ?? 0), 0) : null;
  const totalCacheWriteUsd = cacheUsdKnown ? merged.reduce((s, r) => s + (r.cacheWriteUsd ?? 0), 0) : null;
  const partial = ov.coverage.partial ? { tone: 'neutral' as const, text: 'partial history' } : undefined;

  const significant = merged.filter((r) => r.estimatedUsd >= ZERO_COST_THRESHOLD);
  const zeroRows = merged.filter((r) => r.estimatedUsd < ZERO_COST_THRESHOLD);
  const sortVal = (r: MergedRow) => (sort.key === 'cacheSavingsUsd' && netKnown ? r.cacheNetUsd ?? 0 : r[sort.key] ?? 0);
  const visible = [...(showZero ? merged : significant)].sort((a, b) => sort.dir * (sortVal(a) - sortVal(b)));
  const toggleSort = (key: SortKey) => setSort((s) => (s.key === key ? { key, dir: (s.dir * -1) as 1 | -1 } : { key, dir: -1 }));
  const caret = (key: SortKey) => (sort.key === key ? (sort.dir === -1 ? ' ▾' : ' ▴') : '');
  const ariaSort = (key: SortKey): 'ascending' | 'descending' | 'none' => (sort.key === key ? (sort.dir === -1 ? 'descending' : 'ascending') : 'none');
  const sum = (k: Exclude<SortKey, 'cacheSavingsUsd' | 'cacheReadUsd' | 'cacheWriteUsd'>) => visible.reduce((s, r) => s + r[k], 0);
  // Never show the gross read saving under a "net" heading: without the net field the column reads "—".
  const sumNet = netKnown ? visible.reduce((s, r) => s + (r.cacheNetUsd ?? 0), 0) : null;
  const sumNullable = (k: 'cacheReadUsd' | 'cacheWriteUsd') => (cacheUsdKnown ? visible.reduce((s, r) => s + (r[k] ?? 0), 0) : null);
  const usdOrDash = (v: number | null) => (v == null ? <span className="muted" aria-label="not available">—</span> : fmtUsd(v));

  // Rows are rounded per model; their sum can miss the window total by a cent. Say so rather than let a reader hunt for it.
  const centGap = Math.round(Math.abs(sum('estimatedUsd') - totalEstimatedUsd) * 100);
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
  // "Models used" counts models that moved tokens in the window. A PROJDAY row can exist with zero tokens
  // (calls that were throttled or returned nothing), and such a row is not a model "used" (qa F-PR69-006).
  const hasTokens = (r: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens?: number }) =>
    r.inputTokens + r.outputTokens + r.cacheReadTokens + (r.cacheWriteTokens ?? 0) > 0;
  const usedRows = ov.byModel.filter(hasTokens);
  const usedModels = mergeModelRows(usedRows).length;
  const windowIds = countModelIds(mergeModelRows(usedRows));
  // All time includes every window, so every id seen in the window counts too. /v1/costs can list fewer ids
  // than the PROJDAY rollups behind the window (qa F-PR69-005: 90d said 24/33, all-time said 20/29).
  // Count the union with the widest window (not the selected one) so the figure does not move with the
  // selector and is never smaller than any window.
  const allTimeCounts = allTime ? modelCounts([...allTime.byModel, ...(widest?.byModel ?? []), ...ov.byModel]) : null;
  const footer = (allTimeCounts
    ? `All time: ${fmtUsd(allTime!.totalEstimatedUsd)} across ${plural(allTimeCounts.models, 'model')} (${plural(allTimeCounts.ids, 'id')}, counted the same way as the tile above) · the same rate card prices the By project and Overview pages, so their totals reconcile with this one.`
    : 'All-time total unavailable — the costs endpoint did not respond.')
    + (centGap > 0 ? ` The shown rows sum to ${fmtUsd(sum('estimatedUsd'))}, ${plural(centGap, 'cent')} from the tile — per-model rounding${!showZero && zeroRows.length ? ` and ${plural(zeroRows.length, 'folded model')} below $${ZERO_COST_THRESHOLD.toFixed(2)}` : ''}.` : '');
  // What the estimate prices, in one place. Cache writes (the bill's largest token line) were priced at $0 until
  // feature-36; the standard-route tier (×1.1) was missing until feature-38. Nothing on the bill's token lines is
  // left unpriced now; what remains different is credits, refunds and private pricing.
  // Cache-read rates are per model: 0.1× input on most Claude rows, 0.05× on Opus 5.5 / Sonnet 5.5, 0.025× on
  // Fable 5.1 / Mythos 5.1 (AWS Price List). The page must not state one multiple as if it held for all (qa F-PR69-001).
  const pricingNote = 'Est. cost is the sum of the four billed token kinds — input, output, cache-read (at each model\'s cache-read rate, '
    + '0.025×–0.1× of its input rate) and cache-write; the '
    + 'two cache columns show those two lines in dollars, already inside Est. cost. Cache-write is priced at '
    + '1.25× input for the 5-minute TTL, 2× for 1-hour, read per call from the logged response; writes whose TTL is not '
    + 'logged are priced at the 5-minute rate. Route: global. calls at the global tier; us./geo cross-region, '
    + 'inference-profile and direct calls at the standard tier, ×1.1 (Amazon Nova has one tier). "Cache net" is read '
    + 'savings minus the write premium; see docs/RECONCILIATION.md for the monthly comparison with the bill.';

  return (
    <>
      <div className="kpi-grid">
        <KpiTile label="Estimated spend" helpId="cost.estimated-spend" accent="var(--primary)"
          value={fmtUsd(totalEstimatedUsd)}
          delta={ov.spend.deltaPct != null ? { value: ov.spend.deltaPct, unit: 'pct', compareLabel: compare, goodDirection: 'down' } : undefined}
          sparkline={ov.spend.daily.map((d) => d.usd)}
          definition={`${windowLabel} · token-based estimate${ov.spend.deltaPct == null && ov.spend.priorUsd === 0 ? ' · no prior-period data to compare' : ''}`}
          status={partial} />
        <KpiTile label="Net effect of prompt caching" helpId="cost.cache-net" accent={net != null && net < 0 ? 'var(--danger)' : 'var(--accent-green)'}
          value={net != null ? (net < 0 ? `−${fmtUsd(-net)}` : fmtUsd(net)) : '—'}
          status={net != null && net < 0 ? { tone: 'warn', text: 'caching cost more than it saved' } : undefined}
          definition={net != null && savings != null && totalCacheWriteUsd != null
            ? `${windowLabel} · reads saved ${fmtUsd(savings)} − write premium ${fmtUsd(savings - net)} · writes billed ${fmtUsd(totalCacheWriteUsd)} in total`
            : `${windowLabel} · net cache figure not reported for this time range`} />
        <KpiTile label="Models used" helpId="cost.models-used" accent="var(--accent-blue)"
          value={String(usedModels)}
          definition={`${windowLabel} · ${windowIds !== usedModels ? `${plural(windowIds, 'distinct id')} — regional variants and inference-profile ARNs of one model merged` : 'one id per model'}${usedModels !== merged.length ? ` · ${plural(merged.length - usedModels, 'row')} with calls but no tokens not counted` : ''}`} />
        <KpiTile label="Cache-read tokens" helpId="cost.cache-read-tokens" accent="var(--accent-amber)"
          value={fmtTokens(totalCacheRead)} definition={`${windowLabel} · billed at each model's cache-read rate (0.025×–0.1× input)`} />
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
                <th className="num" aria-sort={ariaSort('cacheWriteTokens')}><button className="th-sort" onClick={() => toggleSort('cacheWriteTokens')}>Cache-write{caret('cacheWriteTokens')}</button></th>
                <th className="num" aria-sort={ariaSort('cacheReadUsd')}><button className="th-sort" onClick={() => toggleSort('cacheReadUsd')} disabled={!cacheUsdKnown}>Cache-read (USD){caret('cacheReadUsd')}</button></th>
                <th className="num" aria-sort={ariaSort('cacheWriteUsd')}><button className="th-sort" onClick={() => toggleSort('cacheWriteUsd')} disabled={!cacheUsdKnown}>Cache-write (USD){caret('cacheWriteUsd')}</button></th>
                <th className="num" aria-sort={ariaSort('cacheSavingsUsd')}><button className="th-sort" onClick={() => toggleSort('cacheSavingsUsd')} disabled={!netKnown}>Cache net (USD){caret('cacheSavingsUsd')}</button></th>
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
                  <td className="num muted">{fmtTokens(m.cacheWriteTokens)}</td>
                  <td className="num">{usdOrDash(m.cacheReadUsd)}</td>
                  <td className="num">{usdOrDash(m.cacheWriteUsd)}</td>
                  <td className="num">{usdOrDash(netKnown ? m.cacheNetUsd : null)}</td>
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
                <td className="num muted">{fmtTokens(sum('cacheWriteTokens'))}</td>
                <td className="num">{usdOrDash(sumNullable('cacheReadUsd'))}</td>
                <td className="num">{usdOrDash(sumNullable('cacheWriteUsd'))}</td>
                <td className="num">{usdOrDash(sumNet)}</td>
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
        <p className="muted" style={{ fontSize: 12, marginTop: 8, marginBottom: 0 }}>{pricingNote}</p>
      </Panel>
    </>
  );
}
