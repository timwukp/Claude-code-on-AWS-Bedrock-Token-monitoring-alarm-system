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

/** Athena result rows → table rows (row 0 is the header).
 *
 * `names` relabels a row the SQL could only identify by project id: the AIP attribution tier
 * yields the id (the project_mapping CSV is keyed by requestMetadata project_id, not by profile),
 * while Fast shows registry names. Without this, one project reads as "Agent Skills Best Practice"
 * in Fast and "agent-skills" in Full. Applied before the merge so both tiers' rows for a project
 * collapse into one row rather than sitting side by side under two labels. */
function mapAthenaProjectRows(rows: any[], names?: Map<string, { name: string; costCenter: string }>): any[] {
  return rows.slice(1).map((r) => {
    const c = r?.Data ?? [];
    const label = c[0]?.VarCharValue ?? 'untagged';
    const hit = names?.get(label);
    const cc = c[1]?.VarCharValue ?? '—';
    return {
      projectName: hit?.name ?? label,
      costCenter: cc !== '—' ? cc : (hit?.costCenter ?? '—'),
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
  const [rollupsAsOf, setRollupsAsOf] = useState<string | null>(null);
  const [apiTotalCost, setApiTotalCost]     = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [loading, setLoading] = useState(true);
  const [elapsedSec, setElapsedSec] = useState(0);

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
          setRollupsAsOf((r as { rollupsAsOf?: string | null }).rollupsAsOf ?? null);
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
          api.projects('fast').then((r) => {
            setRollupsAsOf((r as { rollupsAsOf?: string | null }).rollupsAsOf ?? null);
            return {
              tokens: r.totalTokens != null ? Number(r.totalTokens) : null,
              usd: r.totalEstimatedUsd != null ? Number(r.totalEstimatedUsd) : null,
              // Registry names, reused to relabel AIP-attributed Athena rows (see
              // mapAthenaProjectRows). This response is already being fetched for the totals.
              names: new Map((r.projects ?? []).map((p: any) => [
                String(p.projectId), { name: String(p.projectName ?? p.projectId), costCenter: String(p.costCenter ?? '—') },
              ])),
            };
          }).catch(() => ({ tokens: null, usd: null, names: new Map<string, { name: string; costCenter: string }>() })),
        ]);
        // Athena latency is genuinely variable (measured 18s to several minutes under queue
        // contention). Polling for up to 10 minutes with a visible elapsed timer is honest;
        // failing at an arbitrary 2-minute mark while the query is still RUNNING was not (F-601).
        const started = Date.now();
        const deadline = started + 600_000;
        setElapsedSec(0);
        for (;;) {
          if (cancelled) return;
          const res = await api.pollQuery(id);
          if (res.state === 'SUCCEEDED') {
            if (cancelled) return;
            // Rows arrive per (project, model) priced with the SAME rate card as the rollups;
            // the SQL resolves application-inference-profile ARNs to their underlying model via
            // the registry cache, so both pipelines price identically (F-501 root cause). No
            // proportional scaling — any residual is real and is disclosed in the KPI footer.
            setRows(mergeProjectRows(mapAthenaProjectRows(res.rows ?? [], fastTotals.names)));
            setServedFrom('athena (async, per-model pricing)');
            setApiTotalTokens(fastTotals.tokens);
            setApiTotalUsd(fastTotals.usd);
            setLoading(false);
            return;
          }
          if (res.state === 'FAILED' || res.state === 'CANCELLED') {
            throw new Error('Athena query failed — most often the project_mapping table has not been created yet (see docs/ATTRIBUTION.md)');
          }
          if (Date.now() > deadline) throw new Error('Athena query still running after 10 minutes — the workgroup may be saturated; use Retry later');
          setElapsedSec(Math.round((Date.now() - started) / 1000));
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
  // Sum the rows as a reader would — each value rounded to the cent first — so the disclosed
  // residual is the one they can reproduce from the table, not an invisible sub-cent drift (F-1706).
  const rowsCost   = Math.round(rows.reduce((s, r) => s + Math.round((Number(r.estimatedUsd) || 0) * 100), 0)) / 100;
  const totalTokens = apiTotalTokens ?? rowsTokens;
  const totalCost   = apiTotalUsd ?? rowsCost;
  const centDrift   = apiTotalUsd != null ? Math.round(Math.abs(apiTotalUsd - rowsCost) * 100) / 100 : 0;

  // The three header tiles do NOT all come from the same place, and with Full selected that is
  // visible in the numbers: "Projects tracked" counts the Athena rows below, while both totals stay
  // on the per-model rollups (F-401, so they keep matching the Cost page). Reading the header as one
  // dataset is therefore wrong — 5 projects next to totals covering 21 of them. Each tile names its
  // own source instead of binding all three to one: binding to the rows would discard the
  // authoritative rollup totals, binding to the rollups would misstate the Athena row count.
  const rowSource = source === 'full' ? 'Athena' : 'rollups';
  const srcChip = (text: string) => <span className="badge neutral">{text}</span>;

  return (
    <>
      <div className="kpi-grid">
        <Kpi label="Projects tracked" value={String(rows.length)} accent="var(--primary)"
             chip={srcChip(rowSource)}
             foot={source === 'full'
               ? 'rows in the table below — Athena over the raw logs, so it counts only projects whose attribution is resolvable at call time (tiers ① and ②); the totals beside it are rollup-sourced and cover every tier'
               : 'rows in the table below — the DynamoDB rollups, all four attribution tiers'} />
        <Kpi label="Total tokens" value={fmtTokens(totalTokens)} accent="var(--accent-blue)"
             chip={srcChip(apiTotalTokens != null ? 'rollups' : rowSource)}
             foot={apiTotalTokens != null
               ? `per-model rollups across every project, not just the ${rows.length} row(s) above (those sum to ${fmtTokens(rowsTokens)})${rollupsAsOf ? ` · as of ${rollupsAsOf.slice(11, 16)} UTC` : ''}`
               : 'sum of the rows in the table below'} />
        <Kpi label="Total est. cost" value={fmtUsd(totalCost)} accent="var(--accent-green)"
             chip={srcChip(apiTotalUsd != null ? 'rollups' : rowSource)}
             foot={apiTotalUsd != null && Math.abs(apiTotalUsd - rowsCost) > 0.5
               ? (source === 'full'
                   ? `Athena rows ${fmtUsd(rowsCost)} vs rollups ${fmtUsd(apiTotalUsd)}${rollupsAsOf ? ` (as of ${rollupsAsOf.slice(11, 16)} UTC)` : ''} — Athena reads raw logs live; rollups refresh every 15 min, so the ${fmtUsd(Math.abs(rowsCost - apiTotalUsd))} difference is traffic since the last rollup`
                   : `rows sum ${fmtUsd(rowsCost)} vs model rollups ${fmtUsd(apiTotalUsd)} — residual ${fmtUsd(Math.abs(apiTotalUsd - rowsCost))} predates per-project tracking`)
               : centDrift > 0
                 ? `per-model rates — same rate card as the Cost page · rows are shown to the cent, so their sum (${fmtUsd(rowsCost)}) can differ from this total by a few cents${rollupsAsOf ? ` · rollups as of ${rollupsAsOf.slice(11, 16)} UTC` : ''}`
                 : `per-model rates — same rate card as the Cost page${rollupsAsOf ? ` · rollups as of ${rollupsAsOf.slice(11, 16)} UTC` : ''}`} />
      </div>

      <Panel title="Usage by project"
             desc="Attribution precedence per call: ① the project's application inference profile — the call is ROUTED through it, so the invocation log records the profile's ARN as modelId and the aggregator resolves its tums-project tag (config-routed, IAM-enforceable, zero per-call effort); ② requestMetadata.project_id set by the app; ③ identity hint for single-project principals; ④ untagged. Fast = managed DynamoDB rollups (all four tiers, incl. the one-time historical treatment). Full = async Athena over the immutable raw logs — live, call-time truth, so it can run slightly ahead of the 15-minute rollups. Full resolves tiers ① and ②; it cannot resolve ③, and pre-profile history stays 'untagged' there, because an identity hint and the historical treatment exist only as rollup state and no raw-log field carries them. So expect a larger 'untagged' share in Full — that gap is those two tiers, not lost usage.">
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
          <div className="empty"><span className="spinner" /> <span className="muted">{source === 'fast' ? 'loading DynamoDB rollups…' : `Athena scan running asynchronously — ${elapsedSec}s elapsed. Typically 20-60s; under queue contention it can take several minutes. You can switch to Fast meanwhile.`}</span></div>
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
