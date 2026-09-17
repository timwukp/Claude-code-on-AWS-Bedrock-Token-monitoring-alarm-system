import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Bar, BarChart, CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import {
  api, AssistedBy, DoraMetrics, DoraOverviewRow, DoraPrRow, DoraRepo, DoraWindow, MetricValue, SyncStatus, Tier,
} from '../api/client';
import { Kpi, Panel } from '../components/Layout';
import { fmtAgo, fmtAxisHours, fmtDateTime, fmtHours, fmtPct } from '../lib/format';

/**
 * DORA metrics per tracked GitHub repo — deployment frequency, lead time for changes, change
 * failure rate and time to restore — each split into All / AI-assisted / Human-only PRs, so a
 * team can see whether working with AI coding assistants (Claude Code, Kiro, Amazon Q) changes
 * its delivery performance. Admins (Cognito `admin` group) manage the repo list. Backed by
 * GET /v1/dora/* (#12); "deployment" = PR merged to the default branch.
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

function TierBadge({ tier }: { tier: Tier }) {
  return <span className={`badge ${TIER_BADGE[tier]}`}>{tier}</span>;
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

  const kpiFoot = (s: { all: MetricValue; ai: MetricValue; human: MetricValue }, kind: 'df' | 'lt' | 'cfr' | 'mttr') =>
    s.all.n === 0
      ? `Tier: Unknown · no ${kind === 'mttr' ? 'recovery events' : 'merged PRs'} in window`
      : <>Tier: <strong>{s.all.tier}</strong> · AI {fmtMetric(s.ai, kind)} · Human {fmtMetric(s.human, kind)} · n={s.all.n}</>;

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
                <Kpi label="Deployment frequency" value={perDay(m.deploymentFrequency.all.perDay)}
                     accent={TIER_ACCENT[m.deploymentFrequency.all.tier]} foot={kpiFoot(m.deploymentFrequency, 'df')} />
                <Kpi label="Lead time for changes" value={fmtHours(m.leadTime.all.value)}
                     accent={TIER_ACCENT[m.leadTime.all.tier]} foot={kpiFoot(m.leadTime, 'lt')} />
                <Kpi label="Change failure rate" value={fmtPct(m.changeFailureRate.all.value)}
                     accent={TIER_ACCENT[m.changeFailureRate.all.tier]} foot={kpiFoot(m.changeFailureRate, 'cfr')} />
                <Kpi label="Time to restore" value={fmtHours(m.mttr.all.value)}
                     accent={TIER_ACCENT[m.mttr.all.tier]} foot={kpiFoot(m.mttr, 'mttr')} />
                <Kpi label="AI participation" value={fmtPct(m.aiParticipationPct)} accent="var(--primary)"
                     foot={m.sample.mergedPrs === 0 ? 'no merged PRs in window'
                       : (Object.entries(m.byAssistant) as [Exclude<AssistedBy, null>, number][])
                           .filter(([, n]) => n > 0).map(([k, n]) => `${ASSISTANT_LABEL[k]} ${n}`).join(' · ') || 'no AI-assisted PRs detected'} />
              </div>

              {noData ? (
                <div className="empty">
                  <div className="big">📭</div>
                  No PRs merged to <code>{selected.defaultBranch}</code> in the last {windowDays} days.<br />
                  <span className="muted">Try a longer window{selected.prCount === 0 && !isBusy(selected.status) ? ', or check the sync status above' : ''}.</span>
                </div>
              ) : (
                <>
                  <Panel title="Deployments per week" desc="Merged PRs to the default branch, split by whether an AI assistant participated">
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
              <tr><th>Repository</th><th className="num">Merged PRs</th><th className="num">AI %</th><th>Deploy freq.</th><th>Lead time</th><th>Change failure</th><th>Time to restore</th><th>Status</th></tr>
            </thead>
            <tbody>
              {overview.map((r) => (
                <tr key={r.repo} style={{ cursor: 'pointer' }} onClick={() => setRepo(r.repo)} title="Show this repository">
                  <td><strong>{r.repo}</strong></td>
                  <td className="num">{r.mergedPrs}</td>
                  <td className="num">{fmtPct(r.aiParticipationPct)}</td>
                  <td>{perDay(r.df.value)} <TierBadge tier={r.df.tier} /></td>
                  <td>{fmtHours(r.lt.value)} <TierBadge tier={r.lt.tier} /></td>
                  <td>{fmtPct(r.cfr.value)} <TierBadge tier={r.cfr.tier} /></td>
                  <td>{fmtHours(r.mttr.value)} <TierBadge tier={r.mttr.tier} /></td>
                  <td><span className={`badge ${STATUS_BADGE[r.status].cls}`}>{STATUS_BADGE[r.status].text}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
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
