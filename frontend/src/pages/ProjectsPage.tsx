import { useEffect, useState } from 'react';
import { api, RegistryProject } from '../api/client';
import { Kpi, Panel } from '../components/Layout';
import { fmtTokens, fmtUsd } from '../lib/format';

/**
 * Usage attributed to projects/users. Attribution comes from Bedrock requestMetadata tags
 * (user_id, project_id) joined to a customer-supplied project mapping. See docs/ATTRIBUTION.md.
 */
/** Athena returns one row per (project, model); merge them per project (sum tokens/USD, max users). */
function mergeProjectRows(rows: any[]): any[] {
  const m = new Map<string, any>();
  for (const r of rows) {
    const key = `${r.projectName}|${r.costCenter}`;
    const e = m.get(key) ?? { ...r, tokens: 0, estimatedUsd: 0, users: 0 };
    e.tokens += r.tokens ?? 0;
    e.estimatedUsd = Math.round((e.estimatedUsd + (r.estimatedUsd ?? 0)) * 1e6) / 1e6;
    e.users = Math.max(e.users, r.users ?? 0);
    m.set(key, e);
  }
  return [...m.values()].sort((a, b) => b.tokens - a.tokens);
}

/** Athena result rows → table rows (row 0 is the header). */
function mapAthenaProjectRows(rows: any[]): any[] {
  return rows.slice(1).map((r) => {
    const c = r?.Data ?? [];
    return {
      projectName: c[0]?.VarCharValue ?? 'untagged',
      costCenter: c[1]?.VarCharValue ?? '—',
      users: Number(c[2]?.VarCharValue ?? 0),
      tokens: Number(c[3]?.VarCharValue ?? 0),
      estimatedUsd: Math.round(Number(c[4]?.VarCharValue ?? 0) * 1e6) / 1e6,
    };
  });
}

export function ProjectsPage() {
  const [rows, setRows] = useState<any[]>([]);
  const [source, setSource] = useState<'fast' | 'full'>('fast');
  const [servedFrom, setServedFrom] = useState<string>('');
  const [apiTotalTokens, setApiTotalTokens] = useState<number | null>(null);
  const [apiTotalUsd, setApiTotalUsd] = useState<number | null>(null);
  const [apiTotalCost, setApiTotalCost]     = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [loading, setLoading] = useState(true);

  // Project registry (#13): names/cost centers/repo links; admins manage projects here.
  const [registry, setRegistry] = useState<RegistryProject[] | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [form, setForm] = useState({ id: '', name: '', costCenter: '', repos: '', identityArns: '' });
  const [adminBusy, setAdminBusy] = useState(false);
  const [adminMsg, setAdminMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    if (source === 'fast') {
      api.projects('fast')
        .then((r) => {
          if (cancelled) return;
          setRows(r.projects ?? []);
          setServedFrom(r.source ?? 'dynamodb');
          setApiTotalTokens(r.totalTokens != null ? Number(r.totalTokens) : null);
          setApiTotalUsd(r.totalEstimatedUsd != null ? Number(r.totalEstimatedUsd) : null);
        })
        .catch((e) => { if (!cancelled) setError(String(e)); })
        .finally(() => { if (!cancelled) setLoading(false); });
    } else {
      // Full (Athena) view runs ASYNC — start the query, then poll (F-002). The scan takes
      // 15-30s on real data, longer than any sane synchronous API timeout; the old sync path
      // hit the Lambda timeout mid-poll and the browser surfaced status 0 / "Failed to fetch".
      (async () => {
        // Kick the scan and, in parallel, fetch the authoritative per-model totals the Fast
        // path uses — Athena rows are priced at flat reference rates, so they are scaled to
        // these totals exactly like the old sync path did; Fast and Full then agree on Est.
        // USD by construction (QA finding N-001).
        const [{ id }, fastTotals] = await Promise.all([
          api.startQuery('byProject', 90),
          api.projects('fast').then((r) => ({
            tokens: r.totalTokens != null ? Number(r.totalTokens) : null,
            usd: r.totalEstimatedUsd != null ? Number(r.totalEstimatedUsd) : null,
          })).catch(() => ({ tokens: null, usd: null })),
        ]);
        const deadline = Date.now() + 120_000; // scans measured at 20-70s on real data (N-002)
        for (;;) {
          if (cancelled) return;
          const res = await api.pollQuery(id);
          if (res.state === 'SUCCEEDED') {
            if (cancelled) return;
            // Rows arrive per (project, model) priced at flat reference rates — merge per
            // project, then scale USD to the authoritative per-model rollup totals (same
            // numbers as the Cost page). Tokens reconcile exactly across pipelines, so the
            // USD residual is a pricing artifact, not missing history (F-501, restores N-001).
            const merged = mergeProjectRows(mapAthenaProjectRows(res.rows ?? []));
            const rowsUsd = merged.reduce((s, r) => s + (r.estimatedUsd || 0), 0);
            if (fastTotals.usd != null && rowsUsd > 0) {
              const k = fastTotals.usd / rowsUsd;
              for (const r of merged) r.estimatedUsd = Math.round(r.estimatedUsd * k * 1e6) / 1e6;
            }
            setRows(merged);
            setServedFrom('athena (async, scaled to model rollups)');
            setApiTotalTokens(fastTotals.tokens);
            setApiTotalUsd(fastTotals.usd);
            setLoading(false);
            return;
          }
          if (res.state === 'FAILED' || res.state === 'CANCELLED') {
            throw new Error('Athena query failed — most often the project_mapping table has not been created yet (see docs/ATTRIBUTION.md)');
          }
          if (Date.now() > deadline) throw new Error('Athena query still running after 2 minutes — use Retry in a moment');
          await new Promise((r) => setTimeout(r, 2500));
        }
      })().catch((e) => {
        if (!cancelled) { setError(String(e).replace(/^Error: /, '')); setLoading(false); }
      });
    }
    return () => { cancelled = true; };
  }, [source, refreshKey]);

  useEffect(() => {
    let cancelled = false;
    api.projectRegistry()
      .then((r) => { if (!cancelled) { setRegistry(r.projects); setIsAdmin(r.isAdmin); } })
      .catch(() => { if (!cancelled) setRegistry(null); }); // registry endpoint absent → hide panel
    return () => { cancelled = true; };
  }, [refreshKey]);

  const runAdmin = async (label: string, fn: () => Promise<unknown>) => {
    setAdminBusy(true); setAdminMsg(null);
    try { await fn(); setAdminMsg({ kind: 'ok', text: `${label} — done` }); setRefreshKey((k) => k + 1); }
    catch (e) { setAdminMsg({ kind: 'err', text: String(e).replace(/^Error: /, '') }); }
    finally { setAdminBusy(false); }
  };
  const csv = (v: string) => v.split(',').map((x) => x.trim()).filter(Boolean);
  const saveProject = () => {
    if (!form.id.trim() || !form.name.trim()) return;
    runAdmin(`Saved ${form.id.trim()}`, async () => {
      await api.projectRegistryUpsert({
        id: form.id.trim(), name: form.name.trim(),
        costCenter: form.costCenter.trim() || undefined,
        repos: csv(form.repos), identityArns: csv(form.identityArns),
      });
      setForm({ id: '', name: '', costCenter: '', repos: '', identityArns: '' });
    });
  };
  const editProject = (p: RegistryProject) => setForm({
    id: p.projectId, name: p.name, costCenter: p.costCenter ?? '',
    repos: p.repos.join(', '), identityArns: p.identityArns.join(', '),
  });
  const deleteProject = (id: string) => {
    if (!window.confirm(`Remove project ${id} from the registry? Usage rollups are kept.`)) return;
    runAdmin(`Removed ${id}`, () => api.projectRegistryDelete(id));
  };

  // Keep the page frame (toggle stays clickable) while a source loads; only the table area spins.
  const bodyLoading = loading;

  // KPIs prefer the authoritative per-model rollup totals (same numbers as the Cost page);
  // the rows' own sums are kept separately so any residual is disclosed, not hidden (F-401).
  const rowsTokens = rows.reduce((s, r) => s + (Number(r.tokens) || 0), 0);
  const rowsCost   = rows.reduce((s, r) => s + (Number(r.estimatedUsd) || 0), 0);
  const totalTokens = apiTotalTokens ?? rowsTokens;
  const totalCost   = apiTotalUsd ?? rowsCost;

  return (
    <>
      <div className="kpi-grid">
        <Kpi label="Projects tracked" value={String(rows.length)} accent="var(--primary)" />
        <Kpi label="Total tokens" value={fmtTokens(totalTokens)} accent="var(--accent-blue)" />
        <Kpi label="Total est. cost" value={fmtUsd(totalCost)} accent="var(--accent-green)"
             foot={apiTotalUsd != null && Math.abs(apiTotalUsd - rowsCost) > 0.5
               ? `rows sum ${fmtUsd(rowsCost)} vs model rollups ${fmtUsd(apiTotalUsd)} — residual ${fmtUsd(Math.abs(apiTotalUsd - rowsCost))} is pre-project-tracking history`
               : 'per-model rates — same rate card as the Cost page; rows reconcile to the model rollups'} />
      </div>

      <Panel title="Usage by project"
             desc="Attribution precedence per call: ① the project's application inference profile — the call is ROUTED through it, so the invocation log records the profile's ARN as modelId and the aggregator resolves its tums-project tag (config-routed, IAM-enforceable, zero per-call effort); ② requestMetadata.project_id set by the app; ③ identity hint for single-project principals; ④ untagged. Fast = managed DynamoDB rollups (full attribution, incl. the one-time historical treatment). Full = async Athena over the immutable raw logs — call-time truth, so pre-profile history stays 'untagged' there by design.">
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14 }}>
          <div style={{ display: 'inline-flex', border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
            {(['fast', 'full'] as const).map((s) => (
              <button key={s} onClick={() => setSource(s)}
                style={{
                  padding: '6px 14px', fontSize: 13, border: 'none', cursor: 'pointer',
                  background: source === s ? 'var(--primary)' : '#fff',
                  color: source === s ? '#fff' : 'var(--text-dim)', fontWeight: source === s ? 600 : 400,
                }}>
                {s === 'fast' ? 'Fast (DynamoDB)' : 'Full (Athena + names)'}
              </button>
            ))}
          </div>
          {servedFrom && <span className="muted" style={{ fontSize: 12 }}>served from: <strong>{servedFrom}</strong></span>}
        </div>
        {bodyLoading ? (
          <div className="empty"><span className="spinner" /> <span className="muted">loading {source === 'fast' ? 'DynamoDB rollups' : 'Athena scan — usually under a minute, occasionally up to two (running async)'}…</span></div>
        ) : error ? (
          <div className="empty"><div className="big">⚠️</div>Failed to load: {error}{' '}
            <button onClick={() => { setError(null); setRefreshKey((k) => k + 1); }}
                    style={{ marginLeft: 10 }}>Retry</button>
          </div>
        ) : rows.length === 0 ? (
          <div className="empty">
            <div className="big">🗂️</div>
            No project-tagged usage yet.<br />
            <span className="muted">
              Have your application pass <code>requestMetadata: {'{ project_id, user_id }'}</code> on
              Bedrock calls, and upload a project-mapping CSV. See docs/ATTRIBUTION.md.
            </span>
          </div>
        ) : (
          <table className="data">
            <thead>
              <tr>
                <th>Project</th><th>Cost center</th>
                <th className="num">Users</th><th className="num">Tokens</th><th className="num">Est. USD</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i}>
                  <td><strong>{r.projectName ?? r.projectId}</strong></td>
                  <td className="muted">{r.costCenter ?? '—'}</td>
                  <td className="num">{r.users ?? '—'}</td>
                  <td className="num">{fmtTokens(Number(r.tokens ?? 0))}</td>
                  <td className="num"><strong>{fmtUsd(Number(r.estimatedUsd ?? 0))}</strong></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>

      {isAdmin && registry && (
        <Panel title="Manage projects" desc="Admin group only — a project is the join key of the platform: it names a cost bucket (cost center + inference-profile tag), links GitHub repos (DORA metrics), and optionally claims caller identities (attribution fallback for single-project principals)">
          <div className="inline-form" style={{ marginBottom: 8, flexWrap: 'wrap' }}>
            <input value={form.id} onChange={(e) => setForm({ ...form, id: e.target.value })} placeholder="id (slug, e.g. token-monitoring)" style={{ minWidth: 200 }} disabled={adminBusy} aria-label="Project id" />
            <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Display name" style={{ minWidth: 200 }} disabled={adminBusy} aria-label="Project name" />
            <input value={form.costCenter} onChange={(e) => setForm({ ...form, costCenter: e.target.value })} placeholder="Cost center (optional)" style={{ minWidth: 160 }} disabled={adminBusy} aria-label="Cost center" />
          </div>
          <div className="inline-form" style={{ marginBottom: 12, flexWrap: 'wrap' }}>
            <input value={form.repos} onChange={(e) => setForm({ ...form, repos: e.target.value })} placeholder="Repos, comma-separated (owner/name, owner/name)" style={{ minWidth: 420 }} disabled={adminBusy} aria-label="Repos" />
            <input value={form.identityArns} onChange={(e) => setForm({ ...form, identityArns: e.target.value })} placeholder="Identity ARNs (optional, comma-separated)" style={{ minWidth: 320 }} disabled={adminBusy} aria-label="Identity ARNs" />
            <button className="btn-primary" onClick={saveProject} disabled={adminBusy || !form.id.trim() || !form.name.trim()}>Save project</button>
            {adminMsg && <span className={adminMsg.kind === 'err' ? 'error-text' : 'muted'} style={{ marginTop: 0, fontSize: 13 }}>{adminMsg.text}</span>}
          </div>
          {registry.length > 0 && (
            <table className="data">
              <thead><tr><th>Project</th><th>Cost center</th><th>Repos</th><th>Identity hints</th><th></th></tr></thead>
              <tbody>
                {registry.map((p) => (
                  <tr key={p.projectId}>
                    <td><strong>{p.name}</strong> <span className="muted mono" style={{ fontSize: 12 }}>{p.projectId}</span></td>
                    <td className="muted">{p.costCenter ?? '—'}</td>
                    <td className="mono" style={{ fontSize: 12 }}>{p.repos.join(', ') || '—'}</td>
                    <td className="num">{p.identityArns.length}</td>
                    <td className="num" style={{ whiteSpace: 'nowrap' }}>
                      <button className="btn-sm" onClick={() => editProject(p)} disabled={adminBusy}>Edit</button>{' '}
                      <button className="btn-sm danger" onClick={() => deleteProject(p.projectId)} disabled={adminBusy}>Remove</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
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
      )}
    </>
  );
}
