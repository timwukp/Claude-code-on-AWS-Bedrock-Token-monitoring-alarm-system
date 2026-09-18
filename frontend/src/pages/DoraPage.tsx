import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Bar, BarChart, CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import {
  api, AssistedBy, DoraDataSource, DoraMetrics, DoraOverviewRow, DoraPrRow, DoraProjectRow, DoraRepo, DoraWindow, SyncStatus,
} from '../api/client';
import { Disclosure, Kpi, Panel } from '../components/Layout';
import { fmtAgo, fmtAxisHours, fmtDateTime, fmtHours, fmtPct, fmtTokens, fmtUsd } from '../lib/format';

/**
 * Software delivery performance per tracked GitHub repo — DORA's four measurable metrics, each
 * split into All / AI-assisted / Human-only PRs, so a team can see whether working with AI coding
 * assistants changes its delivery performance. Admins manage the repo list. GET /v1/dora/* (#12).
 *
 * Presentation contract, from `docs/research-dora-card-copy.md` (which supersedes
 * `research-dora-presentation.md` where the two disagree):
 *  - **One card = one canonical noun label + at most one qualifier chip + one number + one line of
 *    sample provenance.** Definitions, deviations and bands live in the disclosure at the bottom.
 *  - **No band, tier or benchmark on any card face** (§4, 3-0). DORA's own live instrument scores
 *    delivery performance on a continuous scale against an industry mean; `Elite/High/Medium/Low`
 *    appear zero times as labels in it. The measured rate leads; the 2024 bands are dated reference
 *    data inside the disclosure. This reverses the band-as-headline choice shipped in #42.
 *  - No percentile either: it is the defensible substitute for a band, and it needs a benchmark
 *    distribution this product does not have (§5). The disclosure says so rather than staying quiet.
 *  - Labels are the canonical nouns from one dora.dev surface, cited by URL, because DORA's own
 *    surfaces disagree with each other about these names (§1–2). Note "change fail rate".
 *  - Coverage state — `not collected`, an empty sample — stays **on the card face** (§7). It is a
 *    finding about this tenant's data, not a definition.
 *  - The disclosure is a native `<details>`, never a hover tooltip (§7: NN/g, WCAG 1.4.13).
 *  - The AI metric is not one of DORA's, so it does not sit in the DORA grid, and it is named for
 *    exactly what it counts: PRs carrying an AI co-author trailer (§8).
 */

const WINDOWS: DoraWindow[] = [7, 30, 90];
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
const parseWindow = (raw: string | null): DoraWindow => (WINDOWS.includes(Number(raw) as DoraWindow) ? (Number(raw) as DoraWindow) : 30);

/** The rate a reader compares with. DORA states this metric ordinally, never as a per-day decimal. */
const perWeek = (perDayValue: number | null) => (perDayValue == null ? '—' : `${(perDayValue * 7).toFixed(1)} / week`);

/**
 * The one qualifier a card is allowed. It names the *kind* of gap between our measurement and
 * DORA's definition; the gap itself is spelled out in the disclosure, which is where a reader can
 * actually read it. The title is a pointer, deliberately not a second copy of the caveat.
 */
const Chip = ({ text }: { text: string }) => (
  <span className="badge neutral" title="How this differs from DORA's definition is in “Definitions & limitations” below">{text}</span>
);

/**
 * How each card relates to the canonical metric. One row per DORA metric, including the one we do
 * not collect — naming the gap costs less than the credibility of a four-metric page presented as
 * the whole framework.
 */
const METRIC_MAP: readonly { dora: string; here: string; deviation: string }[] = [
  {
    dora: 'Deployment frequency',
    here: 'Merges to the default branch, per week',
    deviation: 'Proxy. DORA counts deployments that reach production, and its own reference tooling warns that deriving deployment metrics from merge events skews them.',
  },
  {
    dora: 'Change lead time',
    here: 'Median hours from first commit on the PR to merge',
    deviation: 'Partial. The start point is DORA\'s exactly (a commit in version control); DORA\'s window ends in production, so this measures its first part.',
  },
  {
    dora: 'Change fail rate',
    here: 'Reverts + hotfixes + bug/incident issues, over merges',
    deviation: 'Detector-based: PR titles, labels, branch names and issue labels. 0% means nothing matched those detectors, not that nothing broke.',
  },
  {
    dora: 'Failed deployment recovery time',
    here: 'Median of hotfix PR open→merge and incident open→close',
    deviation: 'Not DORA\'s metric, so it does not take its name. DORA counts only impairments caused by a change reaching production; this also counts issues with no deployment linkage.',
  },
  {
    dora: 'Deployment rework rate',
    here: 'Not collected',
    deviation: 'Needs a signal marking a deployment as planned or corrective. Nothing in this pipeline records one.',
  },
];

export function DoraPage() {
  const [params, setParams] = useSearchParams();
  const windowDays = parseWindow(params.get('window'));
  const repoParam = params.get('repo');

  const [repos, setRepos] = useState<DoraRepo[] | null>(null);
  const [tokenConfigured, setTokenConfigured] = useState(true);
  const [isAdmin, setIsAdmin] = useState(false);
  const [reposError, setReposError] = useState<string | null>(null);

  const [detail, setDetail] = useState<{ repo: DoraRepo; metrics: DoraMetrics; recentPrs: DoraPrRow[]; dataSource: DoraDataSource } | null>(null);
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
        setDetail({ repo: m.repo, metrics: m.metrics, recentPrs: m.recentPrs, dataSource: m.dataSource });
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

  // One line of sample provenance per card: what was counted, over what window. Nothing else.
  const noMerges = `no merges to ${selected?.defaultBranch ?? 'the default branch'} in ${windowDays} days`;
  const aiAssisted = m ? Object.values(m.byAssistant).reduce((a, b) => a + b, 0) : 0;
  const assistantBreakdown = m
    ? (Object.entries(m.byAssistant) as [Exclude<AssistedBy, null>, number][])
      .filter(([, n]) => n > 0).map(([k, n]) => `${ASSISTANT_LABEL[k]} ${n}`).join(' · ')
    : '';

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

              {/* DORA's own umbrella term is "software delivery performance", split into
                  throughput and stability. Recovery time sits under stability: three of DORA's
                  four first-party surfaces put it there, including its live instrument, even
                  though the definitions guide files it under throughput. */}
              <Panel title="Software delivery throughput" desc={`How much change reaches ${selected.defaultBranch}, and how long it takes to get there`}>
                <div className="kpi-grid" style={{ marginBottom: 0 }}>
                  <Kpi label="Deployment frequency" chip={<Chip text="proxy" />}
                       value={m.deploymentFrequency.all.n === 0 ? '—' : perWeek(m.deploymentFrequency.all.value)}
                       foot={m.deploymentFrequency.all.n === 0 ? noMerges
                         : `${m.deploymentFrequency.all.n} merges to ${selected.defaultBranch} · ${windowDays} days`} />
                  <Kpi label="Change lead time" chip={<Chip text="partial" />} value={fmtHours(m.leadTime.all.value)}
                       foot={m.leadTime.all.n === 0 ? noMerges
                         : `median first commit → merge · ${m.leadTime.all.n} changes`} />
                </div>
              </Panel>

              <Panel title="Software delivery stability" desc="How often a change goes wrong, and how long the recovery takes">
                <div className="kpi-grid" style={{ marginBottom: 0 }}>
                  <Kpi label="Change fail rate" value={fmtPct(m.changeFailRate.all.value)}
                       foot={m.changeFailRate.all.n === 0 ? noMerges
                         : `${m.changeFailRate.all.failures} of ${m.changeFailRate.all.n} changes reverted, hotfixed or tied to an incident`} />
                  <Kpi label="Recovery time" chip={<Chip text="not DORA's" />} value={fmtHours(m.mttr.all.value)}
                       foot={m.mttr.all.n === 0 ? 'no hotfixes or incidents in this window'
                         : `median problem recorded → fixed · ${m.mttr.all.n} event${m.mttr.all.n === 1 ? '' : 's'}`} />
                  {/* Coverage state stays on the card face: it is a finding about this data, not a
                      definition, so it does not belong behind the disclosure. */}
                  <Kpi label="Deployment rework rate" chip={<Chip text="not collected" />} value="—"
                       foot="needs a planned-vs-corrective deployment signal" />
                </div>
              </Panel>
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

                  {/* The cohort split is a second data dimension, not provenance, so it gets its
                      own row instead of a trailing "· AI-assisted n · human-only n" on every card.
                      The AI figure leads this panel rather than the DORA grid: no DORA metric
                      covers AI-authored share, so sitting it among the five would imply sanction. */}
                  <Panel title="AI-assisted vs human-only" desc="Does AI participation change delivery performance? Medians over the window, per cohort">
                    <div className="kpi-grid" style={{ gridTemplateColumns: 'minmax(220px, 1fr)' }}>
                      <Kpi label="AI-assisted changes" value={fmtPct(m.aiParticipationPct)} accent="var(--primary)"
                           foot={m.sample.mergedPrs === 0 ? noMerges
                             : <>{aiAssisted} of {m.sample.mergedPrs} PRs carry an AI co-author trailer
                               {assistantBreakdown ? <> ({assistantBreakdown})</> : null}</>} />
                    </div>
                    <table className="data">
                      <thead>
                        <tr><th>Cohort</th><th className="num">Merges</th><th className="num">Coding (first commit → PR)</th><th className="num">Review (PR → merge)</th><th className="num">Total lead time</th><th className="num">p95</th><th className="num">Change fail rate</th></tr>
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
                              <td className="num">{fmtPct(m.changeFailRate[c].value)}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                    <p className="muted" style={{ fontSize: 12, marginTop: 10 }}>
                      Change failures in window: {m.changeFailRate.all.reverts} revert PR(s), {m.changeFailRate.all.hotfixes} hotfix PR(s),{' '}
                      {m.changeFailRate.all.incidents} incident issue(s) — incidents cannot be attributed to a cohort, so they count only under All.
                      Coding, Review and Total are each independent medians, so the stage columns need not sum to the total.
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
              <tr><th>Repository</th><th className="num">Merged PRs</th><th className="num">AI %</th><th className="num">Deployment frequency</th><th className="num">Change lead time</th><th className="num">Change fail rate</th><th className="num">Recovery time</th><th>Status</th></tr>
            </thead>
            <tbody>
              {overview.map((r) => (
                <tr key={r.repo} style={{ cursor: 'pointer' }} onClick={() => setRepo(r.repo)} title="Show this repository">
                  <td><strong>{r.repo}</strong></td>
                  <td className="num">{r.mergedPrs}</td>
                  <td className="num">{fmtPct(r.aiParticipationPct)}</td>
                  {/* Measured values only — no band, tier or benchmark in any cell. */}
                  <td className="num">{perWeek(r.df.value)}</td>
                  <td className="num">{fmtHours(r.lt.value)}</td>
                  <td className="num">{fmtPct(r.cfr.value)}</td>
                  <td className="num">{fmtHours(r.mttr.value)}</td>
                  <td><span className={`badge ${STATUS_BADGE[r.status].cls}`}>{STATUS_BADGE[r.status].text}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      )}

      {/* ---- projects: delivery × cost (#13) ---- */}
      {projectRows && projectRows.length > 0 && (
        <Panel title="Projects — delivery × cost"
               desc={`Each project pools DORA across its repos and prices its Bedrock usage from daily rollups — last ${windowDays} days`}>
          <table className="data">
            <thead>
              <tr><th>Project</th><th className="num">Repos</th><th className="num">Merged PRs</th><th className="num">Deployment frequency</th><th className="num">Change lead time</th><th className="num">AI %</th><th className="num">Tokens</th><th className="num">Est. USD</th><th className="num">$ / merge</th></tr>
            </thead>
            <tbody>
              {projectRows.map((p) => (
                <tr key={p.projectId}>
                  <td><strong>{p.name}</strong> <span className="muted mono" style={{ fontSize: 12 }}>{p.projectId}</span>
                    {p.costCenter && <div className="muted" style={{ fontSize: 12 }}>{p.costCenter}</div>}</td>
                  <td className="num">{p.repos.length}</td>
                  <td className="num">{p.dora?.mergedPrs ?? '—'}</td>
                  <td className="num">{p.dora ? perWeek(p.dora.df.value) : <span className="muted">no repos tracked</span>}</td>
                  <td className="num">{p.dora ? fmtHours(p.dora.lt.value) : <span className="muted">—</span>}</td>
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

      {/* Everything that used to sit on a card face, in one place a reader can open by keyboard.
          Relocating a caveat is not deleting it: every string removed from a card is below. */}
      {detail && (
        <Disclosure summary="Definitions & limitations">
          <p>
            Labels on this page are the canonical metric names from{' '}
            {detail.dataSource.canonicalSource
              ? <a href={detail.dataSource.canonicalSource} target="_blank" rel="noreferrer">DORA's own definitions guide</a>
              : <>DORA's own definitions guide</>}
            . One surface, cited by URL, because DORA's several surfaces disagree with each other about these names.
          </p>

          <h3>How each metric here relates to DORA's</h3>
          <table className="data">
            <thead><tr><th>DORA's metric</th><th>What this page measures</th><th>Where it differs</th></tr></thead>
            <tbody>
              {METRIC_MAP.map((r) => (
                <tr key={r.dora}><td><strong>{r.dora}</strong></td><td>{r.here}</td><td>{r.deviation}</td></tr>
              ))}
            </tbody>
          </table>

          {detail.dataSource.bandReference?.length ? (
            <>
              <h3>The 2024 performance levels, for reference only</h3>
              <p>
                These are the 2024 State of DevOps bands, kept as dated context. They are not shown next to the numbers
                above: DORA's current instrument scores software delivery performance on a continuous scale against an
                industry mean and uses no band as a label, and the 2025 report replaced the levels with team archetypes.
                For recovery time the band was published against DORA's own metric, which is not what this page computes.
              </p>
              <table className="data">
                <thead><tr><th>Metric (DORA's name)</th><th>Elite</th><th>High</th><th>Medium</th><th>Low</th></tr></thead>
                <tbody>
                  {detail.dataSource.bandReference.map((b) => (
                    <tr key={b.metric}>
                      <td><strong>{b.label}</strong></td>
                      {b.bands.map((x) => <td key={x.tier}>{x.text}</td>)}
                    </tr>
                  ))}
                  {detail.dataSource.cfrReference?.length ? (
                    <tr>
                      <td><strong>Change fail rate</strong></td>
                      {detail.dataSource.cfrReference.map((x) => <td key={x.tier}>{x.pct}%</td>)}
                    </tr>
                  ) : null}
                </tbody>
              </table>
              {detail.dataSource.cfrReference?.length ? (
                <p>
                  The change-fail-rate row is deliberately not in ascending order, and no band is derived from it: the
                  published values rise and fall across the levels because the levels are clusters over all metrics at
                  once, so this metric alone cannot place a team.
                </p>
              ) : null}
            </>
          ) : null}

          <h3>What this page does not claim</h3>
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {detail.dataSource.notes.map((n) => <li key={n} style={{ marginBottom: 4 }}>{n}</li>)}
          </ul>
        </Disclosure>
      )}
    </>
  );
}
