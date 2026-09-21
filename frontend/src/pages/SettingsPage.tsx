import { useEffect, useState } from 'react';
import { api, DoraRepo, RegistryProject, SyncStatus } from '../api/client';
import { EmptyState } from '../components/EmptyState';
import { Panel } from '../components/Layout';
import { fmtAgo } from '../lib/format';

/**
 * Administration lives here, not inside the monitoring pages: the project registry (the platform's
 * join key — cost bucket, linked repos, identity hints) and the DORA repository list. Both panels
 * were lifted from By project and DORA unchanged in behaviour; those pages now link here.
 */

const STATUS_BADGE: Record<SyncStatus, { cls: string; text: string }> = {
  ok: { cls: 'success', text: 'synced' },
  pending: { cls: 'info', text: 'sync queued' },
  syncing: { cls: 'info', text: 'syncing…' },
  'rate-limited': { cls: 'warning', text: 'rate-limited' },
  'token-not-configured': { cls: 'warning', text: 'token not configured' },
  error: { cls: 'critical', text: 'sync error' },
};
const isBusy = (s: SyncStatus) => s === 'pending' || s === 'syncing';
const csv = (v: string) => v.split(',').map((x) => x.trim()).filter(Boolean);

type Msg = { kind: 'ok' | 'err'; text: string } | null;

export function SettingsPage() {
  const [isAdmin, setIsAdmin] = useState<boolean | null>(null);
  const [registry, setRegistry] = useState<RegistryProject[] | null>(null);
  const [repos, setRepos] = useState<DoraRepo[] | null>(null);
  const [tokenConfigured, setTokenConfigured] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const [form, setForm] = useState({ id: '', name: '', costCenter: '', repos: '', identityArns: '' });
  const [projBusy, setProjBusy] = useState(false);
  const [projMsg, setProjMsg] = useState<Msg>(null);
  const [newRepo, setNewRepo] = useState('');
  const [repoBusy, setRepoBusy] = useState(false);
  const [repoMsg, setRepoMsg] = useState<Msg>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([api.projectRegistry(), api.doraRepos()])
      .then(([reg, dr]) => {
        if (cancelled) return;
        setRegistry(reg.projects); setRepos(dr.repos); setTokenConfigured(dr.tokenConfigured);
        setIsAdmin(Boolean(reg.isAdmin || dr.isAdmin)); setError(null);
      })
      .catch((e) => { if (!cancelled) { setError(String(e)); setIsAdmin(false); } });
    return () => { cancelled = true; };
  }, [refreshKey]);

  const run = async (setBusy: (b: boolean) => void, setMsg: (m: Msg) => void, label: string, fn: () => Promise<unknown>) => {
    setBusy(true); setMsg(null);
    try { await fn(); setMsg({ kind: 'ok', text: `${label} — done` }); setRefreshKey((k) => k + 1); }
    catch (e) { setMsg({ kind: 'err', text: String(e).replace(/^Error: /, '') }); }
    finally { setBusy(false); }
  };

  const saveProject = () => {
    if (!form.id.trim() || !form.name.trim()) return;
    run(setProjBusy, setProjMsg, `Saved ${form.id.trim()}`, async () => {
      await api.projectRegistryUpsert({
        id: form.id.trim(), name: form.name.trim(), costCenter: form.costCenter.trim() || undefined,
        repos: csv(form.repos), identityArns: csv(form.identityArns),
      });
      setForm({ id: '', name: '', costCenter: '', repos: '', identityArns: '' });
    });
  };
  const editProject = (p: RegistryProject) => setForm({
    id: p.projectId, name: p.name, costCenter: p.costCenter ?? '', repos: p.repos.join(', '), identityArns: p.identityArns.join(', '),
  });
  const deleteProject = (id: string) => {
    if (!window.confirm(`Remove project ${id} from the registry? Usage rollups are kept.`)) return;
    run(setProjBusy, setProjMsg, `Removed ${id}`, () => api.projectRegistryDelete(id));
  };
  const addRepo = () => {
    const v = newRepo.trim(); if (!v) return;
    run(setRepoBusy, setRepoMsg, `Added ${v}`, async () => { await api.doraAddRepo(v); setNewRepo(''); });
  };
  const removeRepo = (repo: string) => {
    if (!window.confirm(`Remove ${repo} from DORA tracking? Collected metrics for it are kept.`)) return;
    run(setRepoBusy, setRepoMsg, `Removed ${repo}`, () => api.doraDeleteRepo(repo));
  };
  const syncRepo = (repo: string) => run(setRepoBusy, setRepoMsg, `Sync queued for ${repo}`, () => api.doraSyncRepo(repo));

  if (error) return <EmptyState kind="error" title="Settings could not be loaded" detail={error} action={{ label: 'Retry', onClick: () => setRefreshKey((k) => k + 1) }} />;
  if (isAdmin === null) return <EmptyState kind="loading" title="Loading settings…" />;
  if (!isAdmin) return (
    <EmptyState kind="empty" icon="shield" title="Administrator access required"
      detail="Project registry and DORA repository management are limited to the admin group. Ask an administrator to add you, or to make the change for you."
      action={{ label: 'Back to Overview', to: '/' }} />
  );

  return (
    <>
      <Panel title="Projects" helpId="project.tracked"
             desc="A project is the platform's join key: it names a cost bucket (cost center + inference-profile tag), links GitHub repositories (DORA metrics), and optionally claims caller identities (attribution fallback for single-project principals).">
        <div className="inline-form" style={{ marginBottom: 8, flexWrap: 'wrap' }}>
          <input value={form.id} onChange={(e) => setForm({ ...form, id: e.target.value })} placeholder="id (slug, e.g. token-monitoring)" style={{ minWidth: 200 }} disabled={projBusy} aria-label="Project id" />
          <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Display name" style={{ minWidth: 200 }} disabled={projBusy} aria-label="Project name" />
          <input value={form.costCenter} onChange={(e) => setForm({ ...form, costCenter: e.target.value })} placeholder="Cost center (optional)" style={{ minWidth: 160 }} disabled={projBusy} aria-label="Cost center" />
        </div>
        <div className="inline-form" style={{ marginBottom: 12, flexWrap: 'wrap' }}>
          <input value={form.repos} onChange={(e) => setForm({ ...form, repos: e.target.value })} placeholder="Repos, comma-separated (owner/name, owner/name)" style={{ minWidth: 420 }} disabled={projBusy} aria-label="Repos" />
          <input value={form.identityArns} onChange={(e) => setForm({ ...form, identityArns: e.target.value })} placeholder="Identity ARNs (optional, comma-separated)" style={{ minWidth: 320 }} disabled={projBusy} aria-label="Identity ARNs" />
          <button className="btn-primary" onClick={saveProject} disabled={projBusy || !form.id.trim() || !form.name.trim()}>Save project</button>
          {projMsg && <span className={projMsg.kind === 'err' ? 'error-text' : 'muted'} style={{ marginTop: 0, fontSize: 13 }} role="status">{projMsg.text}</span>}
        </div>
        {registry && registry.length > 0 ? (
          <table className="data">
            <thead><tr><th>Project</th><th>Cost center</th><th>Repos</th><th className="num">Identity hints</th><th></th></tr></thead>
            <tbody>
              {registry.map((p) => (
                <tr key={p.projectId}>
                  <td><strong>{p.name}</strong> <span className="muted mono" style={{ fontSize: 12 }}>{p.projectId}</span></td>
                  <td className="muted">{p.costCenter ?? '—'}</td>
                  <td className="mono" style={{ fontSize: 12 }}>{p.repos.join(', ') || '—'}</td>
                  <td className="num">{p.identityArns.length}</td>
                  <td className="num" style={{ whiteSpace: 'nowrap' }}>
                    <button className="btn-sm" onClick={() => editProject(p)} disabled={projBusy}>Edit</button>{' '}
                    <button className="btn-sm danger" onClick={() => deleteProject(p.projectId)} disabled={projBusy}>Remove</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <EmptyState kind="empty" title="No projects registered" detail="Add the first project above; the Projects stack creates its inference profiles on the next deploy." />
        )}
        <p className="muted" style={{ fontSize: 12, marginTop: 10 }}>
          How the AIP mapping works end-to-end: the Tums-*-Projects stack creates one inference profile per
          project × model, tagged tums-project=&lt;id&gt;. A repo's committed Claude Code settings (or an app
          passing the profile ARN as modelId) route every call through it — no per-call tagging. The
          invocation log then records the profile ARN as modelId; the aggregator resolves the ARN once via
          its tag, caches it in this registry, and re-keys the record to the real underlying model so
          per-model pricing stays exact. With the opt-in IAM policy, tagged profiles are the ONLY invokable
          path, making attribution unforgeable; the same tag flows to Cost Explorer for billing-grade $.
          Identity hints cover principals dedicated to one project; usage that predates the profiles was
          attributed once, offline, by commit-time correlation — method and audit artifact in
          docs/ATTRIBUTION.md.
        </p>
      </Panel>

      <Panel title="Tracked repositories (DORA)" helpId="dora.deployment-frequency"
             desc="Add a public GitHub repository, trigger a sync, or remove one. Metrics are computed on read from the collected pull requests.">
        {!tokenConfigured && (
          <p className="error-text" style={{ marginTop: 0 }}>The collector's GitHub token is not configured — repositories can be added but will not sync until it is.</p>
        )}
        <div className="inline-form" style={{ marginBottom: 14 }}>
          <input value={newRepo} onChange={(e) => setNewRepo(e.target.value)} placeholder="owner/name  (e.g. timwukp/agent-skills-best-practice)"
                 onKeyDown={(e) => { if (e.key === 'Enter') addRepo(); }} disabled={repoBusy} aria-label="Repository to add" />
          <button className="btn-primary" onClick={addRepo} disabled={repoBusy || !newRepo.trim()}>Add repository</button>
          {repoMsg && <span className={repoMsg.kind === 'err' ? 'error-text' : 'muted'} style={{ marginTop: 0, fontSize: 13 }} role="status">{repoMsg.text}</span>}
        </div>
        {repos && repos.length > 0 ? (
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
                    <button className="btn-sm" onClick={() => syncRepo(r.repo)} disabled={repoBusy || isBusy(r.status)}>Sync now</button>{' '}
                    <button className="btn-sm danger" onClick={() => removeRepo(r.repo)} disabled={repoBusy}>Remove</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <EmptyState kind="empty" title="No repositories tracked" detail="Add one above to start collecting DORA metrics." />
        )}
      </Panel>
    </>
  );
}
