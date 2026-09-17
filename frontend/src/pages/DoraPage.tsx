import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Bar, BarChart, CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import {
  api, AssistedBy, DoraMetrics, DoraOverviewRow, DoraPrRow, DoraProjectRow, DoraRepo, DoraWindow, MetricValue, SyncStatus, Tier,
} from '../api/client';
import { Kpi, Panel } from '../components/Layout';
import { fmtAgo, fmtAxisHours, fmtDateTime, fmtHours, fmtPct, fmtTokens, fmtUsd } from '../lib/format';

/**
 * DORA metrics per tracked GitHub repo — deployment frequency, change lead time, change failure
 * rate and recovery time — each split into All / AI-assisted / Human-only PRs, so a team can see
 * whether working with AI coding assistants (Claude Code, Kiro, Amazon Q) changes its delivery
 * performance. Admins (Cognito `admin` group) manage the repo list. Backed by GET /v1/dora/* (#12).
 *
 * Presentation rules, all traceable to `docs/research-dora-presentation.md`:
 *  - A "deployment" here is a PR merged to the default branch, which is a PROXY for DORA's
 *    production deployment. The word "proxy" belongs at the number, not in a footnote (§1.8).
 *  - Deployment frequency leads with DORA's ordinal band; the per-day rate is the supporting
 *    arithmetic, because DORA never states this metric as a rate (§1.3).
 *  - Change failure rate carries NO tier badge: the 2024 band values are non-monotonic, so a tier
 *    is not derivable from that metric alone (§1.4). The four published values are shown instead.
 *  - Every tier badge is dated 2024, since the 2025 report replaced the levels with archetypes.
 *  - DORA has five metrics; the one we cannot compute is named rather than quietly dropped (§1.1).
 */

const WINDOWS: DoraWindow[] = [7, 30, 90];
const TIER_ACCENT: Record<Tier, string> = {
  Elite: 'var(--accent-green)',
  High: 'var(--accent-blue)',
  Medium: 'var(--warning)',
  Low: 'var(--danger)',
  Unknown: 'var(--text-dim)',
};
const TIER_BADGE: Record<Tier, string> = { Elite: 'success', High: 'info', Medium: 'warning', Low: 'critical', Unknown: 'neutral' };
const ASSISTANT_LABEL: Record<Exclude<AssistedBy, null>, string> = {
  'claude-code': 'Claude Code', kiro: 'Kiro', 'amazon-q': 'Amazon Q', copilot: 'Copilot',
};
const STATUS_BADGE: Record<SyncStatus, { cls: string; text: string }> = {
  ok: { cls: 'success', text: 'synced' },
  pending: { cls: 'info', text: 'sync queued' },
  syncing: { cls: 'info', text: 'syncing…' },
  'rate-limited': { cls: 'warning', text: 'rate-limited' },
  'token-not-configured': { cls: 'warning', text: 'token not configured' },
  error: { cls: 'critical', text: 'sync error' },
};
const POLL_MS = 10_000;
const POLL_MAX = 12;

const isBusy = (s: SyncStatus) => s === 'pending' || s === 'syncing';
const perDay = (v: number | null) => (v == null ? '—' : `${v.toFixed(2)}/day`);
const fmtMetric = (m: MetricValue, kind: 'df' | 'lt' | 'cfr' | 'mttr') =>
  kind === 'df' ? perDay(m.value) : kind === 'cfr' ? fmtPct(m.value) : fmtHours(m.value);
const parseWindow = (raw: string | null): DoraWindow => (WINDOWS.includes(Number(raw) as DoraWindow) ? (Number(raw) as DoraWindow) : 30);

/**
 * Short headline for each of DORA's six ordinal bands. The band string itself is the citable
 * label and is always printed alongside; this is only what fits on one line of a KPI tile.
 */
const BAND_HEADLINE: Record<string, string> = {
  'On demand (multiple deploys per day)': 'On demand',
  'Between once per hour and once per day': 'About daily',
  'Between once per day and once per week': 'About weekly',
  'Between once per week and once per month': 'About monthly',
  'Between once per month and once every six months': 'A few times a year',
  'Less than once per six months': 'Rarely',
};
const bandHeadline = (band: string | null) => (band == null ? '—' : BAND_HEADLINE[band] ?? band);

/**
 * Tier badges are dated on purpose. The 2024 State of DevOps levels were replaced by seven team
 * archetypes in 2025, so an undated badge asserts a framework that has since moved. `Unknown`
 * means the window had no sample, which is a different statement from a low tier.
 */
function TierBadge({ tier }: { tier: Tier }) {
  if (tier === 'Unknown') return <span className="badge neutral" title="Not enough data in this window to place a band">no band</span>;
  return (
    <span className={`badge ${TIER_BADGE[tier]}`}
          title="2024 State of DevOps band. DORA applies these per application or service as an annual survey benchmark — not a grade or a maturity level.">
      {tier} (2024)
    </span>
  );
}

export function DoraPage() {
  const [params, setParams] = useSearchParams();
  const windowDays = parseWindow(params.get('window'));
  const repoParam = params.get('repo');

  const [repos, setRepos] = useState<DoraRepo[] | null>(null);
  const [tokenConfigured, setTokenConfigured] = useState(true);
  const [isAdmin, setIsAdmin] = useState(false);
  const [reposError, setReposError] = useState<string | null>(null);

  const [detail, setDetail] = useState<{ repo: DoraRepo; metrics: DoraMetrics; recentPrs: DoraPrRow[]; notes: string[] } | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  const [overview, setOverview] = useState<DoraOverviewRow[] | null>(null);
  const [projectRows, setProjectRows] = useState<DoraProjectRow[] | null>(null);

  const [refreshKey, setRefreshKey] = useState(0);
  const [pollCount, setPollCount] = useState(0);
  const [newRepo, setNewRepo] = useState('');
  const [adminBusy, setAdminBusy] = useState(false);
  const [adminMsg, setAdminMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  // Selected repo: URL param if it is tracked, else the first tracked repo.
  const selected = useMemo(() => {
    if (!repos?.length) return null;
    return repos.find((r) => r.repo.toLowerCase() === (repoParam ?? '').toLowerCase()) ?? repos[0];
  }, [repos, repoParam]);

  const setRepo = (repo: string) => setParams((p) => { p.set('repo', repo); return p; }, { replace: true });
  const setWindow = (w: DoraWindow) => setParams((p) => { p.set('window', String(w)); return p; }, { replace: true });

  // 1) Registry (drives everything else). Re-runs on manual refresh and on poll ticks.
  useEffect(() => {
    let cancelled = false;
    api.doraRepos()
      .then((r) => { if (cancelled) return; setRepos(r.repos); setTokenConfigured(r.tokenConfigured); setIsAdmin(r.isAdmin); setReposError(null); })
      .catch((e) => { if (!cancelled) { setReposError(String(e)); setRepos((prev) => prev ?? []); } });
    return () => { cancelled = true; };
  }, [refreshKey, pollCount]);

  // 2) Poll while any repo is syncing (bounded — never spins forever).
  const anyBusy = !!repos?.some((r) => isBusy(r.status));
  useEffect(() => {
    if (!anyBusy || pollCount >= POLL_MAX) return;
    const t = setTimeout(() => setPollCount((c) => c + 1), POLL_MS);
    return () => clearTimeout(t);
  }, [anyBusy, pollCount, repos]);
  useEffect(() => { if (!anyBusy) setPollCount(0); }, [anyBusy]);

  // 3) Per-repo metrics for the selection + the cross-repo overview.
  useEffect(() => {
    if (!selected) { setDetail(null); return; }
    let cancelled = false;
    setDetailLoading(true);
    Promise.all([api.doraMetrics(selected.repo, windowDays), api.doraOverview(windowDays)])
      .then(([m, o]) => {
        if (cancelled) return;
        setDetail({ repo: m.repo, metrics: m.metrics, recentPrs: m.recentPrs, notes: m.dataSource.notes });
        setOverview(o.repos);
        setDetailError(null);
      })
      .catch((e) => { if (!cancelled) setDetailError(String(e)); })
      .finally(() => { if (!cancelled) setDetailLoading(false); });
    return () => { cancelled = true; };
  }, [selected?.repo, windowDays, refreshKey, repos?.map((r) => `${r.repo}:${r.lastSyncedAt}`).join('|')]);

  // Delivery × Cost rows (#13) — best-effort: the panel hides if the endpoint is unavailable.
  useEffect(() => {
    let cancelled = false;
    api.doraProjects(windowDays)
      .then((r) => { if (!cancelled) setProjectRows(r.projects); })
      .catch(() => { if (!cancelled) setProjectRows(null); });
    return () => { cancelled = true; };
  }, [windowDays, refreshKey]);

  const refresh = useCallback(() => setRefreshKey((k) => k + 1), []);

  const runAdmin = async (label: string, fn: () => Promise<unknown>) => {
    setAdminBusy(true); setAdminMsg(null);
    try { await fn(); setAdminMsg({ kind: 'ok', text: `${label} — done` }); refresh(); }
    catch (e) { setAdminMsg({ kind: 'err', text: String(e).replace(/^Error: /, '') }); }
    finally { setAdminBusy(false); }
  };
  const addRepo = () => {
    const v = newRepo.trim();
    if (!v) return;
    runAdmin(`Added ${v}`, async () => { await api.doraAddRepo(v); setNewRepo(''); setRepo(v); });
  };
  const removeRepo = (repo: string) => {
    if (!window.confirm(`Remove ${repo} and all its collected data from the dashboard?`)) return;
    runAdmin(`Removed ${repo}`, () => api.doraDeleteRepo(repo));
  };
  const syncRepo = (repo: string) => runAdmin(`Sync queued for ${repo}`, () => api.doraSyncRepo(repo));

  // ---------- render ----------
  if (repos === null && !reposError) return <div className="empty"><span className="spinner" /></div>;

  const m = detail?.metrics;
  const tl = m?.timeline ?? [];
  const noData = !!m && m.sample.mergedPrs === 0;

  // Plain-language footers: say what the number means before naming the tier.
  const perWeek = (perDay: number | null) => (perDay == null ? '—' : `${(perDay * 7).toFixed(1)} / week`);
  const kpiFoot = (s: { all: MetricValue & { band?: string | null }; ai: MetricValue; human: MetricValue }, kind: 'df' | 'lt' | 'cfr' | 'mttr') => {
    if (s.all.n === 0) {
      return kind === 'mttr'
        ? 'Nothing to recover from — no hotfixes or incident issues in this window'
        : `No PRs merged to the default branch in the last ${windowDays} days`;
    }
    const band = <>2024 DORA band: <strong>{s.all.tier}</strong></>;
    switch (kind) {
      case 'df':
        return <>DORA's own wording: "{s.all.band ?? '—'}" · {s.all.n} merges in {windowDays} days ≈ {perWeek(s.all.value)} · {band} · AI-assisted {s.ai.n} · human-only {s.human.n}</>;
      case 'lt':
        return <>median from first commit to merge — DORA's window starts at the same commit but ends in production, so this is the first part of it · AI-assisted {fmtHours(s.ai.value)} · human-only {fmtHours(s.human.value)} · {band}</>;
      // No tier on this metric: see TierBadge/§1.4. The published values are printed so the reader
      // still has something to compare against.
      case 'cfr':
        return <>{Math.round(((s.all.value ?? 0) / 100) * s.all.n)} of {s.all.n} changes needed a revert or hotfix, or coincided with a bug/incident issue · <strong>no band</strong>: the 2024 values are non-monotonic (Elite 5% · High 20% · Medium 10% · Low 40%), so this metric alone cannot place a team</>;
      default:
        return <>median from problem recorded to fix merged, over {s.all.n} event{s.all.n === 1 ? '' : 's'} · this is not DORA's failed deployment recovery time, which counts only failures caused by a change reaching production · {band}</>;
    }
  };

  return (
    <>
      {/* ---- controls ---- */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 18, flexWrap: 'wrap' }}>
        {repos && repos.length > 0 && (
          <div className="seg" aria-label="Repository">
            {repos.map((r) => (
              <button key={r.repo} className={selected?.repo === r.repo ? 'active' : ''} onClick={() => setRepo(r.repo)} title={r.repo}>
                {r.name}
              </button>
            ))}
          </div>
        )}
        <div className="seg" aria-label="Window">
          {WINDOWS.map((w) => (
            <button key={w} className={windowDays === w ? 'active' : ''} onClick={() => setWindow(w)}>{w} days</button>
          ))}
        </div>
        {selected && (
          <span className="muted" style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <span className={`badge ${STATUS_BADGE[selected.status].cls}`}>{STATUS_BADGE[selected.status].text}</span>
            last sync {fmtAgo(selected.lastSyncedAt)} · {selected.prCount} PRs collected
          </span>
        )}
        <button className="btn-sm" onClick={refresh} style={{ marginLeft: 'auto' }}>Refresh</button>
      </div>

      {/* ---- informational states (never alarming for expected conditions) ---- */}
      {reposError && (
        <div className="empty"><div className="big">⚠️</div>Failed to load: {reposError}{' '}
          <button className="btn-sm" onClick={refresh} style={{ marginLeft: 10 }}>Retry</button></div>
      )}
      {!reposError && !tokenConfigured && (
        <Panel title="GitHub token not configured" desc="The collector needs a read-only GitHub token before it can gather data">
          <p className="muted" style={{ fontSize: 13, margin: 0 }}>
            Store a fine-grained personal access token (public repositories, read-only) in the Secrets Manager secret{' '}
            <code>token-monitor-demo/github-token</code>, then use <strong>Sync now</strong> below (admins) or wait for the
            next scheduled run. Unauthenticated GitHub access is limited to 60 requests/hour, which is not enough to backfill.
          </p>
        </Panel>
      )}
      {!reposError && repos && repos.length === 0 && (
        <div className="empty">
          <div className="big">📦</div>
          No repositories tracked yet.<br />
          <span className="muted">{isAdmin ? 'Add one below to start collecting DORA metrics.' : 'Ask an administrator to add a repository.'}</span>
        </div>
      )}

      {/* ---- metrics for the selected repo ---- */}
      {selected && (
        <>
          {detailLoading && !detail ? (
            <div className="empty"><span className="spinner" /> <span className="muted">computing metrics…</span></div>
          ) : detailError ? (
            <div className="empty"><div className="big">⚠️</div>Failed to load: {detailError}{' '}
              <button className="btn-sm" onClick={refresh} style={{ marginLeft: 10 }}>Retry</button></div>
          ) : m && (
            <>
              {isBusy(selected.status) && selected.prCount === 0 && (
                <p className="muted" style={{ fontSize: 13, marginTop: -6 }}>
                  ⏳ First sync in progress — this usually takes under a minute. {pollCount >= POLL_MAX ? 'Still running; use Refresh to check again.' : 'This page refreshes automatically.'}
                </p>
              )}
              {selected.status === 'rate-limited' || selected.status === 'error' ? (
                <p className="muted" style={{ fontSize: 13, marginTop: -6 }}>
                  Last sync {STATUS_BADGE[selected.status].text}{selected.error ? `: ${selected.error}` : ''}. Metrics below use the data collected so far.
                </p>
              ) : null}

              <div className="kpi-grid">
                {/* The band is the headline; the rate lives in the footer. "proxy" and "to main"
                    are in the label itself, because the reader who only reads labels is exactly
                    the reader who must not mistake this for a production deployment count. */}
                <Kpi label="How often do changes reach main? (deployment-frequency proxy)"
                     value={m.deploymentFrequency.all.n === 0 ? '—' : bandHeadline(m.deploymentFrequency.all.band)}
                     accent={TIER_ACCENT[m.deploymentFrequency.all.tier]} foot={kpiFoot(m.deploymentFrequency, 'df')} />
                <Kpi label="How long from first commit to main? (part of change lead time)" value={fmtHours(m.leadTime.all.value)}
                     accent={TIER_ACCENT[m.leadTime.all.tier]} foot={kpiFoot(m.leadTime, 'lt')} />
                <Kpi label="How often does a change need a revert or hotfix?" value={fmtPct(m.changeFailureRate.all.value)}
                     accent="var(--text-dim)" foot={kpiFoot(m.changeFailureRate, 'cfr')} />
                <Kpi label="How long to recover once something breaks?" value={fmtHours(m.mttr.all.value)}
                     accent={TIER_ACCENT[m.mttr.all.tier]} foot={kpiFoot(m.mttr, 'mttr')} />
                {/* The fifth metric. Naming the gap is cheaper than the credibility cost of a
                    four-metric page presented as the whole framework. */}
                <Kpi label="Deployment rework rate (5th DORA metric)" value="not collected" accent="var(--text-dim)"
                     foot="Share of deployments that were unplanned fixes. It needs a signal marking a deployment as planned or corrective, which nothing in this pipeline records today." />
                <Kpi label="How much did AI help write it?" value={fmtPct(m.aiParticipationPct)} accent="var(--primary)"
                     foot={m.sample.mergedPrs === 0 ? 'no merged PRs in window'
                       : <>{Object.values(m.byAssistant).reduce((a, b) => a + b, 0)} of {m.sample.mergedPrs} PRs had an AI assistant
                         {(Object.entries(m.byAssistant) as [Exclude<AssistedBy, null>, number][]).filter(([, n]) => n > 0).length
                           ? <> ({(Object.entries(m.byAssistant) as [Exclude<AssistedBy, null>, number][]).filter(([, n]) => n > 0).map(([k, n]) => `${ASSISTANT_LABEL[k]} ${n}`).join(' · ')})</> : null}</>} />
              </div>

              <p className="muted" style={{ fontSize: 12, marginTop: -12 }}>
                DORA has <strong>five</strong> metrics; four of them are measurable from this data. A "deployment" here is a
                PR merged to the default branch — a <strong>proxy</strong>, since DORA counts deployments that reach
                production, and its own reference tooling warns that deriving deployment metrics from merge events skews
                them. Bands are the <strong>2024</strong> State of DevOps levels, which DORA applies per application or
                service as an annual survey benchmark rather than a grade; the 2025 report replaced them with team
                archetypes. Change failure rate carries no band because the 2024 values are non-monotonic across the
                levels, so no single metric can place a team. Reverts, hotfixes and incidents are detected from PR titles,
                branch names and issue labels, so <strong>0% means nothing matched those detectors</strong>, not that
                nothing broke.
              </p>
              {noData ? (
                <div className="empty">
                  <div className="big">📭</div>
                  No PRs merged to <code>{selected.defaultBranch}</code> in the last {windowDays} days.<br />
                  <span className="muted">Try a longer window{selected.prCount === 0 && !isBusy(selected.status) ? ', or check the sync status above' : ''}.</span>
                </div>
              ) : (
                <>
                  <Panel title="Merges to the default branch per week" desc="The deployment-frequency proxy over time, split by whether an AI assistant participated">
                    <ResponsiveContainer width="100%" height={280}>
                      <BarChart data={tl} margin={{ left: 4, right: 12, top: 8 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#eef2f7" vertical={false} />
                        <XAxis dataKey="week" tick={{ fontSize: 12, fill: '#64748b' }} tickLine={false} axisLine={{ stroke: '#e2e8f0' }} tickFormatter={(w: string) => w.slice(5)} />
                        <YAxis allowDecimals={false} tick={{ fontSize: 12, fill: '#64748b' }} tickLine={false} axisLine={false} width={32} tickFormatter={(n: number) => (n === 0 ? '' : String(n))} />
                        <Tooltip contentStyle={{ borderRadius: 10, border: '1px solid #e2e8f0', fontSize: 13 }} />
                        <Legend iconType="circle" wrapperStyle={{ fontSize: 13, paddingTop: 8 }} />
                        <Bar dataKey="deploysHuman" name="Human-only PRs" stackId="d" fill="#2563eb" radius={[0, 0, 0, 0]} />
                        <Bar dataKey="deploysAi" name="AI-assisted PRs" stackId="d" fill="#6366f1" radius={[4, 4, 0, 0]} />
                      </BarChart>
                    </ResponsiveContainer>
                  </Panel>

                  <Panel title="Lead time per week" desc="Median hours from first commit to merge for PRs merged that week">
                    <ResponsiveContainer width="100%" height={260}>
                      <LineChart data={tl} margin={{ left: 4, right: 12, top: 8 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#eef2f7" vertical={false} />
                        <XAxis dataKey="week" tick={{ fontSize: 12, fill: '#64748b' }} tickLine={false} axisLine={{ stroke: '#e2e8f0' }} tickFormatter={(w: string) => w.slice(5)} />
                        <YAxis tick={{ fontSize: 12, fill: '#64748b' }} tickLine={false} axisLine={false} width={40} tickFormatter={fmtAxisHours} />
                        <Tooltip contentStyle={{ borderRadius: 10, border: '1px solid #e2e8f0', fontSize: 13 }} formatter={(v: number) => fmtHours(v)} />
                        <Line type="monotone" dataKey="medianLeadHours" name="Median lead time" stroke="#16a34a" strokeWidth={2} dot={{ r: 3 }} connectNulls />
                      </LineChart>
                    </ResponsiveContainer>
                  </Panel>

                  <Panel title="Lead time breakdown" desc="Where the time goes, by cohort (medians over the window)">
                    <table className="data">
                      <thead>
                        <tr><th>Cohort</th><th className="num">PRs</th><th className="num">Coding (first commit → PR)</th><th className="num">Review (PR → merge)</th><th className="num">Total lead time</th><th className="num">p95</th><th>Tier</th></tr>
                      </thead>
                      <tbody>
                        {(['all', 'ai', 'human'] as const).map((c) => {
                          const v = m.leadTime[c];
                          return (
                            <tr key={c}>
                              <td><strong>{c === 'all' ? 'All PRs' : c === 'ai' ? 'AI-assisted' : 'Human-only'}</strong></td>
                              <td className="num">{v.n}</td>
                              <td className="num">{fmtHours(v.codingHours)}</td>
                              <td className="num">{fmtHours(v.reviewHours)}</td>
                              <td className="num">{fmtHours(v.value)}</td>
                              <td className="num">{fmtHours(v.p95)}</td>
                              <td><TierBadge tier={v.tier} /></td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                    <p className="muted" style={{ fontSize: 12, marginTop: 10 }}>
                      Change failures in window: {m.changeFailureRate.all.reverts} revert PR(s), {m.changeFailureRate.all.hotfixes} hotfix PR(s),{' '}
                      {m.changeFailureRate.all.incidents} incident issue(s) (labelled bug/incident). Incidents cannot be attributed to a cohort, so they count only under All.
                      Coding / Review / Total are each independent medians over the cohort's PRs, so the stage columns need not sum to the total
                      (e.g. half the PRs spend their time coding, the other half in review → both stage medians can be near zero while the total median is hours).
                    </p>
                  </Panel>

                  <Panel title="Recent merged PRs" desc={`Up to 25 most recent merges in the last ${windowDays} days`}>
                    <table className="data">
                      <thead>
                        <tr><th>#</th><th>Title</th><th>Author</th><th>Merged</th><th className="num">Lead time</th><th>AI assistant</th><th>Flags</th></tr>
                      </thead>
                      <tbody>
                        {detail!.recentPrs.map((p) => (
                          <tr key={p.number}>
                            <td className="mono">{p.number}</td>
                            <td><a href={p.htmlUrl} target="_blank" rel="noreferrer">{p.title}</a></td>
                            <td className="mono">{p.author}</td>
                            <td className="muted">{fmtDateTime(p.mergedAt)}</td>
                            <td className="num">{fmtHours(p.leadHours)}</td>
                            <td>{p.assistedBy ? <span className="badge info">{ASSISTANT_LABEL[p.assistedBy]}</span> : <span className="muted">—</span>}</td>
                            <td>
                              {p.isRevert && <span className="badge critical">Revert</span>}{' '}
                              {p.isHotfix && <span className="badge warning">Hotfix</span>}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </Panel>
                </>
              )}
            </>
          )}
        </>
      )}

      {/* ---- all repos ---- */}
      {overview && overview.length > 0 && (
        <Panel title="All tracked repositories" desc={`Side-by-side over the last ${windowDays} days — same definitions as above`}>
          <table className="data">
            <thead>
              <tr><th>Repository</th><th className="num">Merged PRs</th><th className="num">AI %</th><th>Deploy freq. (proxy)</th><th>Commit → main</th><th>Change failure</th><th>Recovery time</th><th>Status</th></tr>
            </thead>
            <tbody>
              {overview.map((r) => (
                <tr key={r.repo} style={{ cursor: 'pointer' }} onClick={() => setRepo(r.repo)} title="Show this repository">
                  <td><strong>{r.repo}</strong></td>
                  <td className="num">{r.mergedPrs}</td>
                  <td className="num">{fmtPct(r.aiParticipationPct)}</td>
                  <td title={r.df.band ?? undefined}>{bandHeadline(r.df.band)} <span className="muted">{perDay(r.df.value)}</span> <TierBadge tier={r.df.tier} /></td>
                  <td>{fmtHours(r.lt.value)} <TierBadge tier={r.lt.tier} /></td>
                  {/* No badge here on purpose — a per-metric tier is not derivable for this one. */}
                  <td>{fmtPct(r.cfr.value)}</td>
                  <td>{fmtHours(r.mttr.value)} <TierBadge tier={r.mttr.tier} /></td>
                  <td><span className={`badge ${STATUS_BADGE[r.status].cls}`}>{STATUS_BADGE[r.status].text}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="muted" style={{ fontSize: 12, marginTop: 10 }}>
            Deployment frequency is DORA's ordinal band with the measured rate beside it. Change failure rate has no band;
            compare it against the four published 2024 values (Elite 5% · High 20% · Medium 10% · Low 40%), which are not
            in ascending order because the levels are clusters over all metrics at once.
          </p>
        </Panel>
      )}

      {/* ---- projects: delivery × cost (#13) ---- */}
      {projectRows && projectRows.length > 0 && (
        <Panel title="Projects — delivery × cost"
               desc={`Each project pools DORA across its repos and prices its Bedrock usage from daily rollups — last ${windowDays} days`}>
          <table className="data">
            <thead>
              <tr><th>Project</th><th className="num">Repos</th><th className="num">Merged PRs</th><th>Deploy freq. (proxy)</th><th>Commit → main</th><th className="num">AI %</th><th className="num">Tokens</th><th className="num">Est. USD</th><th className="num">$ / merge</th></tr>
            </thead>
            <tbody>
              {projectRows.map((p) => (
                <tr key={p.projectId}>
                  <td><strong>{p.name}</strong> <span className="muted mono" style={{ fontSize: 12 }}>{p.projectId}</span>
                    {p.costCenter && <div className="muted" style={{ fontSize: 12 }}>{p.costCenter}</div>}</td>
                  <td className="num">{p.repos.length}</td>
                  <td className="num">{p.dora?.mergedPrs ?? '—'}</td>
                  <td title={p.dora?.df.band ?? undefined}>{p.dora ? <>{bandHeadline(p.dora.df.band)} <TierBadge tier={p.dora.df.tier} /></> : <span className="muted">no repos tracked</span>}</td>
                  <td>{p.dora ? <>{fmtHours(p.dora.lt.value)} <TierBadge tier={p.dora.lt.tier} /></> : <span className="muted">—</span>}</td>
                  <td className="num">{fmtPct(p.dora?.aiParticipationPct ?? null)}</td>
                  <td className="num">{fmtTokens(p.tokens)}</td>
                  <td className="num"><strong>{fmtUsd(p.estimatedUsd)}</strong></td>
                  <td className="num">{p.usdPerDeployment != null ? fmtUsd(p.usdPerDeployment) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {projectRows.some((p) => p.notes.length > 0) && (
            <p className="muted" style={{ fontSize: 12, marginTop: 10 }}>
              {projectRows.flatMap((p) => p.notes.map((n) => `${p.projectId}: ${n}`)).join(' · ')}
            </p>
          )}
          <p className="muted" style={{ fontSize: 12, marginTop: 6 }}>
            Cost is a token-based estimate (same rate card as the Cost page). The deployment proxy is
            a PR merged to the default branch, so $ / merge is also $ / deployment proxy today.
            Manage projects on the By Project page.
          </p>
        </Panel>
      )}

      {/* ---- admin ---- */}
      {isAdmin && (
        <Panel title="Manage tracked repositories" desc="Admin group only — add a public GitHub repository, trigger a sync, or remove one">
          <div className="inline-form" style={{ marginBottom: 14 }}>
            <input value={newRepo} onChange={(e) => setNewRepo(e.target.value)} placeholder="owner/name  (e.g. timwukp/agent-skills-best-practice)"
                   onKeyDown={(e) => { if (e.key === 'Enter') addRepo(); }} disabled={adminBusy} aria-label="Repository to add" />
            <button className="btn-primary" onClick={addRepo} disabled={adminBusy || !newRepo.trim()}>Add repository</button>
            {adminMsg && <span className={adminMsg.kind === 'err' ? 'error-text' : 'muted'} style={{ marginTop: 0, fontSize: 13 }}>{adminMsg.text}</span>}
          </div>
          {repos && repos.length > 0 && (
            <table className="data">
              <thead><tr><th>Repository</th><th>Default branch</th><th>Added by</th><th>Last sync</th><th>Status</th><th></th></tr></thead>
              <tbody>
                {repos.map((r) => (
                  <tr key={r.repo}>
                    <td><strong>{r.repo}</strong></td>
                    <td className="mono">{r.defaultBranch}</td>
                    <td className="muted">{r.addedBy}</td>
                    <td className="muted" title={r.lastSyncedAt ?? ''}>{fmtAgo(r.lastSyncedAt)}</td>
                    <td><span className={`badge ${STATUS_BADGE[r.status].cls}`} title={r.error ?? ''}>{STATUS_BADGE[r.status].text}</span></td>
                    <td className="num" style={{ whiteSpace: 'nowrap' }}>
                      <button className="btn-sm" onClick={() => syncRepo(r.repo)} disabled={adminBusy || isBusy(r.status)}>Sync now</button>{' '}
                      <button className="btn-sm danger" onClick={() => removeRepo(r.repo)} disabled={adminBusy}>Remove</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>
      )}

      {detail && (
        <p className="muted" style={{ fontSize: 12 }}>
          <strong>How these are measured.</strong> {detail.notes.join(' ')}
        </p>
      )}
    </>
  );
}
