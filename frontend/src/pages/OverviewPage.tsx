import { useEffect, useMemo, useState } from 'react';
import { api, DoraOverviewRow, GovernanceBudget, OverviewResponse } from '../api/client';
import { EmptyState } from '../components/EmptyState';
import { KpiTile } from '../components/KpiTile';
import { Panel } from '../components/Layout';
import { BUDGET_STATUS, budgetState } from '../lib/budget-status';
import { fmtAgo, fmtSignedUsd, fmtTokens, fmtUsd } from '../lib/format';
import { useTimeRange, Window } from '../lib/time-range';

/**
 * The landing page: four headline tiles and "what changed", each linking to the page that owns the
 * detail. Spend and movers come from /v1/overview (PROJDAY, priced with the Cost page's rate card, so
 * the three pages reconcile); budget from AWS Budgets; anomalies filtered client-side to the window;
 * the delivery headline is the organisation total — merges to main per week summed across synced
 * repositories — so it is directly comparable with the per-repository rows on the DORA page.
 */

const detectedAt = (a: any): string => String(a.detectedAt ?? (typeof a.sk === 'string' ? a.sk.replace(/^ANOMALY#/, '').slice(0, 24) : ''));
const doraWindow = (w: Window): 7 | 30 | 90 => (w === 'mtd' ? 30 : w);

export function OverviewPage() {
  const range = useTimeRange([7, 30, 90, 'mtd']);
  const [ov, setOv] = useState<OverviewResponse | null>(null);
  const [ovErr, setOvErr] = useState<string | null>(null);
  const [budget, setBudget] = useState<GovernanceBudget | null | undefined>(undefined);
  const [anoms, setAnoms] = useState<any[] | null>(null);
  const [repos, setRepos] = useState<DoraOverviewRow[] | null>(null);
  const [doraErr, setDoraErr] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setOv(null); setOvErr(null);
    api.overview(range.window).then((r) => { if (!cancelled) setOv(r); }).catch((e) => { if (!cancelled) setOvErr(String(e)); });
    return () => { cancelled = true; };
  }, [range.window]);

  useEffect(() => {
    api.governance().then((r) => setBudget(r.budget)).catch(() => setBudget(null));
    api.anomalies().then((r) => setAnoms(r.anomalies)).catch(() => setAnoms([]));
  }, []);

  useEffect(() => {
    let cancelled = false;
    setRepos(null); setDoraErr(false);
    api.doraOverview(doraWindow(range.window)).then((r) => { if (!cancelled) setRepos(r.repos); }).catch(() => { if (!cancelled) setDoraErr(true); });
    return () => { cancelled = true; };
  }, [range.window]);

  const anomsInWindow = useMemo(() => (anoms ?? []).filter((a) => detectedAt(a) >= range.fromIso), [anoms, range.fromIso]);
  const critical = anomsInWindow.filter((a) => a.severity === 'CRITICAL').length;

  const compare = ov ? `vs ${ov.window.priorFrom.slice(5)} – ${ov.window.priorTo.slice(5)}` : `vs prior ${range.label.toLowerCase().replace('last ', '')}`;
  const bState = budgetState(budget);
  // `df.value` is merges PER DAY (see dora-calc.ts); the DORA page multiplies by 7 to show a weekly
  // rate. Summing per-repo daily rates gives the organisation's merges per day; × 7 for the week.
  const dfValues = (repos ?? []).map((r) => r.df.value).filter((v): v is number => typeof v === 'number');
  const dfTotal = dfValues.length ? dfValues.reduce((a, b) => a + b, 0) * 7 : null;
  const syncedRepos = (repos ?? []).filter((r) => r.status === 'ok').length;
  const topRepo = (repos ?? []).filter((r) => typeof r.df.value === 'number').sort((a, b) => (b.df.value ?? 0) - (a.df.value ?? 0))[0];

  return (
    <>
      <div className="kpi-grid">
        <KpiTile label="Spend" helpId="overview.spend" link={{ to: '/costs', label: 'Cost' }}
          state={ovErr ? 'error' : ov ? 'ready' : 'loading'} stateText={ovErr ? 'Spend data unavailable — the overview endpoint did not respond' : undefined}
          value={ov ? fmtUsd(ov.spend.currentUsd) : ''}
          delta={ov && ov.spend.deltaPct != null ? { value: ov.spend.deltaPct, unit: 'pct', compareLabel: compare, goodDirection: 'down' } : undefined}
          sparkline={ov?.spend.daily.map((d) => d.usd)}
          definition={ov ? `${range.label.toLowerCase()} · ${fmtTokens(ov.spend.tokens)} tokens · token-based estimate${ov.spend.deltaPct == null && ov.spend.priorUsd === 0 ? ' · no prior-period data to compare' : ''}` : undefined}
          status={ov?.coverage.partial ? { tone: 'neutral', text: 'partial history' } : undefined} />

        <KpiTile label="Budget" helpId="overview.budget" link={{ to: '/governance', label: 'Governance' }}
          state={budget === undefined ? 'loading' : 'ready'}
          value={budget && budget.limitUsd > 0 ? fmtUsd(budget.actualUsd) : '—'}
          status={BUDGET_STATUS[bState]}
          definition={bState === 'ok' || bState === 'forecast-over' || bState === 'over'
            ? `of ${fmtUsd(budget!.limitUsd)} budget, month to date · forecast ${fmtUsd(budget!.forecastedUsd)} · AWS Budgets`
            : bState === 'no-billing-data' ? `of ${fmtUsd(budget!.limitUsd)} budget · AWS Budgets reports no billed spend for this account this month` : 'no Bedrock budget configured'} />

        <KpiTile label="Anomalies" helpId="overview.anomalies" link={{ to: '/anomalies', label: 'Anomalies' }}
          state={anoms === null ? 'loading' : 'ready'}
          value={String(anomsInWindow.length)}
          status={critical > 0 ? { tone: 'danger', text: `${critical} critical` } : anomsInWindow.length > 0 ? { tone: 'warn', text: 'warnings only' } : { tone: 'ok', text: 'none detected' }}
          definition={`${range.label.toLowerCase()} · spend-runaway guard + Cost Anomaly Detection`} />

        <KpiTile label="Deployment frequency" helpId="dora.deployment-frequency" link={{ to: '/dora', label: 'DORA' }}
          state={doraErr ? 'error' : repos === null ? 'loading' : dfTotal == null ? 'empty' : 'ready'}
          stateText={doraErr ? 'DORA data unavailable' : 'no synced repositories'}
          value={dfTotal != null ? `${dfTotal.toFixed(1)} / week` : ''}
          definition={`merges to main across ${syncedRepos} synced ${syncedRepos === 1 ? 'repository' : 'repositories'}, last ${doraWindow(range.window)} days${topRepo ? ` · busiest: ${topRepo.repo.split('/').pop()} at ${((topRepo.df.value ?? 0) * 7).toFixed(1)} / week` : ''}${range.window === 'mtd' ? ' (DORA has no month-to-date view)' : ''}`}
          chip={<span className="badge neutral">proxy</span>} />
      </div>

      <Panel title="What changed" helpId="overview.movers"
             desc={ov ? `Projects with the largest change in spend, ${range.label.toLowerCase()} ${compare}${ov.coverage.partial ? ` · rollups begin ${ov.coverage.firstDayWithData ?? 'later than the prior period'}, so the comparison is against an incomplete baseline` : ''}` : 'Projects with the largest change in spend against the prior equal period'}>
        {ovErr ? (
          <EmptyState kind="error" title="Overview could not be loaded" detail={ovErr} action={{ label: 'Retry', onClick: () => location.reload() }} />
        ) : !ov ? (
          <EmptyState kind="loading" title="Loading…" />
        ) : ov.movers.length === 0 ? (
          <EmptyState kind="empty" title={`No project spend recorded in the ${range.label.toLowerCase()}`}
            detail="Per-project rollups start when a call is attributed to a project — via an inference profile, request metadata or an identity hint."
            action={{ label: 'How attribution works', to: '/projects' }} />
        ) : (
          <table className="data">
            <thead>
              <tr><th>Project</th><th className="num">This period</th><th className="num">Prior</th><th className="num">Change</th><th className="num">%</th></tr>
            </thead>
            <tbody>
              {ov.movers.map((m) => (
                <tr key={m.projectId}>
                  <td>{m.name ?? m.projectId}{m.name && <div className="mono muted" style={{ fontSize: 11 }}>{m.projectId}</div>}</td>
                  <td className="num">{fmtUsd(m.currentUsd)}</td>
                  <td className="num muted">{fmtUsd(m.priorUsd)}</td>
                  <td className={`num ${m.deltaUsd > 0 ? 'delta-up' : m.deltaUsd < 0 ? 'delta-down' : ''}`}>{fmtSignedUsd(m.deltaUsd)}</td>
                  <td className="num muted">{m.deltaPct == null ? <span aria-label="no prior spend">—</span> : `${m.deltaPct > 0 ? '+' : ''}${m.deltaPct.toFixed(0)}%`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {ov && (
          <p className="muted" style={{ fontSize: 12, marginTop: 12, marginBottom: 0 }}>
            Data as of {ov.rollupsAsOf ? `${ov.rollupsAsOf.slice(11, 16)} UTC (${fmtAgo(ov.rollupsAsOf)})` : 'the last aggregator run'} · rollups refresh every 15 minutes · figures are token-based estimates, not the AWS bill.
          </p>
        )}
      </Panel>
    </>
  );
}
