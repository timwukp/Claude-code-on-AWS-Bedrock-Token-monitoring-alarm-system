import { useEffect, useMemo, useState } from 'react';
import {
  Bar, BarChart, CartesianGrid, Cell, LineChart, Line, ReferenceLine, ResponsiveContainer,
  Scatter, ScatterChart, Tooltip, XAxis, YAxis, ZAxis,
} from 'recharts';
import { api, Bands, ProjectRoiConfig, RoiMethodology, RoiProjectRow } from '../api/client';
import { Kpi, Panel } from '../components/Layout';
import { RoiModelDiagram } from '../components/RoiModelDiagram';
import { fmtSignedUsd, fmtUsd, fmtUsdK } from '../lib/format';

/**
 * AI-coding ROI (#14) — DORA's published ROI model over this portal's measured data
 * (per-project AI spend × DORA delivery metrics × configured manpower cost). Every number is a
 * disclosed-assumption estimate: the page leads with the minimal-assumption break-even view,
 * shows component waterfalls with signed terms, states what it REFUSES to compute, and carries
 * the honest RCT bracket instead of a hard-coded productivity multiplier.
 * Methodology: docs/ROI_METHODOLOGY.md.
 */

const VERDICT_BADGE: Record<string, { cls: string; text: string }> = {
  'within-rct-bracket': { cls: 'success', text: 'within evidence bracket' },
  'above-rct-bracket': { cls: 'warning', text: 'above evidence bracket' },
  unknown: { cls: 'neutral', text: 'needs labor-cost input' },
};

/** Bands need >=4 weeks of the project's own history (see referenceBands). When they are refused,
 *  say so — a bare em-dash reads as "zero" or "broken", which is the one thing this page must not
 *  do with a missing input. `weeks` is omitted where the caller already prints the reason. */
function bandText(b: Bands | null, fmt: (n: number) => string, weeks?: number): string {
  if (b) return `${fmt(b.p25)} – ${fmt(b.p50)} – ${fmt(b.p90)}`;
  return weeks == null ? '—' : `needs 4+ weeks of history (has ${weeks})`;
}

export function RoiPage() {
  const [windowDays, setWindowDays] = useState<30 | 90>(90);
  const [rows, setRows] = useState<RoiProjectRow[] | null>(null);
  const [methodology, setMethodology] = useState<RoiMethodology | null>(null);
  const [orgDefaults, setOrgDefaults] = useState<ProjectRoiConfig>({});
  const [isAdmin, setIsAdmin] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [showMethod, setShowMethod] = useState(false);
  const [openDrawer, setOpenDrawer] = useState<string | null>(null);
  const [drawerForm, setDrawerForm] = useState<Record<string, string>>({});
  const [adminMsg, setAdminMsg] = useState<string | null>(null);

  // Forward estimator state.
  const [estRef, setEstRef] = useState('');
  const [estPrs, setEstPrs] = useState('8');
  const [estOut, setEstOut] = useState<Awaited<ReturnType<typeof api.roiEstimate>> | null>(null);
  const [estErr, setEstErr] = useState<string | null>(null);
  const [estBusy, setEstBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api.roiProjects(windowDays)
      .then((r) => {
        if (cancelled) return;
        setRows(r.projects); setMethodology(r.methodology); setOrgDefaults(r.orgDefaults); setIsAdmin(r.isAdmin);
        setError(null);
        if (!estRef && r.projects.length) setEstRef(r.projects[0].projectId);
      })
      .catch((e) => { if (!cancelled) setError(String(e)); });
    return () => { cancelled = true; };
  }, [windowDays, refreshKey]);

  const withSpend = useMemo(() => (rows ?? []).filter((p) => p.monthlySpendUsd > 0 || p.mergedPrs > 0), [rows]);

  const saveAssumptions = async (p: RoiProjectRow) => {
    const roi: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(drawerForm)) if (v.trim() !== '') roi[k] = Number(v);
    setAdminMsg(null);
    try {
      // Upsert keeps existing registry fields; the API validates ranges server-side.
      const existing = (await api.projectRegistry()).projects.find((x) => x.projectId === p.projectId);
      await api.projectRegistryUpsert({
        id: p.projectId, name: existing?.name ?? p.name,
        costCenter: existing?.costCenter ?? undefined,
        repos: existing?.repos, identityArns: existing?.identityArns,
        roi: { ...(existing?.roi ?? {}), ...roi },
      });
      setAdminMsg(`Saved assumptions for ${p.projectId}`);
      setOpenDrawer(null); setDrawerForm({}); setRefreshKey((k) => k + 1);
    } catch (e) { setAdminMsg(String(e).replace(/^Error: /, '')); }
  };

  const runEstimate = async () => {
    setEstBusy(true); setEstErr(null); setEstOut(null);
    try { setEstOut(await api.roiEstimate({ reference: estRef, prsPerMonth: Number(estPrs) })); }
    catch (e) { setEstErr(String(e).replace(/^Error: /, '')); }
    finally { setEstBusy(false); }
  };

  if (rows === null && !error) return <div className="empty"><span className="spinner" /></div>;
  if (error) return (
    <div className="empty"><div className="big">⚠️</div>Failed to load: {error}{' '}
      <button className="btn-sm" onClick={() => { setError(null); setRefreshKey((k) => k + 1); }} style={{ marginLeft: 10 }}>Retry</button></div>
  );

  return (
    <>
      {/* ---- methodology banner (honesty first) ---- */}
      <Panel title="How to read this page" desc="High-uncertainty estimates meant to spark a conversation — not a rigid formula (DORA)">
        <p className="muted" style={{ fontSize: 13, marginTop: 0 }}>
          The model is DORA's published AI ROI calculator over this portal's <strong>measured</strong> per-project
          AI spend and delivery metrics, plus <strong>configured</strong> labor-cost assumptions (every default editable).
          Experimental evidence for AI coding speed spans <strong>{methodology?.bracket.lowPct}% to +{methodology?.bracket.highPct}%</strong> —
          no multiplier is assumed; each project resolves it from its own telemetry.{' '}
          <button className="btn-sm" onClick={() => setShowMethod((v) => !v)}>{showMethod ? 'Hide' : 'What this page refuses to compute'}</button>
        </p>
        {showMethod && methodology && (
          <ul className="muted" style={{ fontSize: 13, marginTop: 4 }}>
            {methodology.refuses.map((r, i) => <li key={i}>{r}</li>)}
            <li>{methodology.annualization}</li>
          </ul>
        )}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '14px 0 10px', flexWrap: 'wrap' }}>
          <span className="muted" style={{ fontSize: 13 }}>The model, with this project's numbers:</span>
          <select value={estRef} onChange={(e) => setEstRef(e.target.value)} aria-label="Project shown in the model diagram"
            style={{ padding: '6px 10px', border: '1px solid var(--border)', borderRadius: 8, background: 'var(--surface)', color: 'var(--text)', fontSize: 13 }}>
            {(rows ?? []).map((p) => <option key={p.projectId} value={p.projectId}>{p.name}</option>)}
          </select>
          <span className="muted" style={{ fontSize: 12 }}>solid = measured · dashed = assumed · faded = refused</span>
        </div>
        <RoiModelDiagram row={rows?.find((p) => p.projectId === estRef)} />
      </Panel>

      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 18 }}>
        <div className="seg" aria-label="Window">
          {([30, 90] as const).map((w) => (
            <button key={w} className={windowDays === w ? 'active' : ''} onClick={() => setWindowDays(w)}>{w} days</button>
          ))}
        </div>
        <span className="muted" style={{ fontSize: 12 }}>7-day ROI is deliberately unavailable — annualizing one week is indefensible.</span>
        {adminMsg && <span className="muted" style={{ fontSize: 13 }}>{adminMsg}</span>}
        <button className="btn-sm" onClick={() => setRefreshKey((k) => k + 1)} style={{ marginLeft: 'auto' }}>Refresh</button>
      </div>

      {/* ---- break-even strip (the skeptic-proof lead view) ---- */}
      <Panel title="Break-even — the minimal-assumption view"
             desc="Monthly AI spend ÷ loaded hourly cost = engineer-hours the AI must save to pay for itself. Two inputs, no revenue guesses.">
        <div className="kpi-grid">
          {withSpend.slice(0, 8).map((p) => {
            const be = p.roi.breakEven;
            const v = VERDICT_BADGE[be.verdict];
            return (
              <Kpi key={p.projectId} label={p.name}
                   value={be.hoursPerMonth != null ? `${be.hoursPerMonth} h/mo` : '—'}
                   accent={be.verdict === 'above-rct-bracket' ? 'var(--danger)' : 'var(--accent-green)'}
                   foot={<>
                     {fmtUsd(p.monthlySpendUsd)}/mo spend{be.pctOfCapacity != null ? <> · needs {be.pctOfCapacity}% of team capacity</> : null}
                     {/* Capacity % divides by teamSize. Hours/month needs only the hourly rate, which is
                         an org-level labor constant, but a borrowed team SIZE is this project's own
                         property — say so rather than presenting it as measured. */}
                     {be.pctOfCapacity != null && p.assumptionsSource !== 'project'
                       ? <> (against {p.assumptionsSource === 'org-default' ? 'an org-default' : 'a code-default'} team size)</> : null}
                     {' '}<span className={`badge ${v.cls}`}>{v.text}</span>
                   </>} />
            );
          })}
        </div>
        <p className="muted" style={{ fontSize: 12, marginTop: 4 }}>
          "Within evidence bracket" = the required saving is below the +{methodology?.bracket.highPct}% experimental
          upper bound; it does NOT prove the saving occurs — set each project's own evidence in the assumptions drawer.
        </p>
      </Panel>

      {/* ---- ROI component cards ---- */}
      {withSpend.map((p) => {
        const r = p.roi;
        const waterfall = [
          { name: 'Time saved', usd: r.value.timeSaved.valueUsd, kind: 'value' },
          { name: 'Throughput', usd: r.value.throughput.valueUsd, kind: 'value' },
          { name: 'Stability Δ', usd: r.value.stabilityDelta.valueUsd, kind: 'value' },
          { name: 'AI spend', usd: -r.investment.aiSpend.valueUsd, kind: 'invest' },
          { name: 'Training', usd: -r.investment.training.valueUsd, kind: 'invest' },
          { name: 'Adoption dip', usd: -r.investment.jCurve.valueUsd, kind: 'invest' },
        ];
        const drawerOpen = openDrawer === p.projectId;
        return (
          <Panel key={p.projectId}
                 title={`${p.name} — ROI ${r.roiPct != null ? `${r.roiPct > 0 ? '+' : ''}${r.roiPct}%` : 'not computable'}`}
                 desc={`Annualized from ${r.window} days (×${r.annualizationFactor}) · assumptions: ${p.assumptionsSource}${r.paybackMonths != null ? ` · payback ~${r.paybackMonths} months` : ''}${p.killFast.flagged ? ' · ⚠ review recommended' : ''}`}>
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={waterfall} margin={{ left: 12, right: 12, top: 8 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#eef2f7" vertical={false} />
                <XAxis dataKey="name" tick={{ fontSize: 12, fill: '#64748b' }} tickLine={false} axisLine={{ stroke: '#e2e8f0' }} />
                <YAxis tick={{ fontSize: 12, fill: '#64748b' }} tickLine={false} axisLine={false} tickFormatter={(n: number) => fmtUsdK(n)} width={64} />
                <Tooltip contentStyle={{ borderRadius: 10, border: '1px solid #e2e8f0', fontSize: 13 }} formatter={(v: number) => fmtSignedUsd(v)} />
                <ReferenceLine y={0} stroke="#94a3b8" />
                <Bar dataKey="usd" name="annual USD">
                  {waterfall.map((w, i) => (
                    <Cell key={i} fill={w.usd >= 0 ? (w.kind === 'value' ? '#16a34a' : '#94a3b8') : '#dc2626'} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
            {(r.refusals.length > 0 || p.killFast.flagged) && (
              <p className="muted" style={{ fontSize: 12, marginTop: 6 }}>
                {p.killFast.flagged && <><strong>Review recommended:</strong> {p.killFast.rule} (weeks {p.killFast.weeks.join(', ')}). </>}
                {r.refusals.length > 0 && (
                  <><strong>What this card refuses to compute:</strong> {r.refusals.join(' ')}</>
                )}
              </p>
            )}
            <p className="muted" style={{ fontSize: 12 }}>
              Unit economics (operational, not ROI): {r.unitEconomics.usdPerMergedPr != null ? `${fmtUsd(r.unitEconomics.usdPerMergedPr)}/merged PR` : 'no merged PRs'}
              {r.unitEconomics.usdPerDeployment != null ? ` · ${fmtUsd(r.unitEconomics.usdPerDeployment)}/deployment` : ''}
              {' '}· weekly $ band {p.bands.weeklyUsd
                ? `${bandText(p.bands.weeklyUsd, fmtUsdK)} (${p.bands.weeks} wks)`
                : bandText(null, fmtUsdK, p.bands.weeks)}
            </p>
            {/* aria-expanded/aria-controls are not decoration here: the drawer is a conditionally
                rendered div, so without them neither a screen reader nor an automated UI checker
                can tell an open drawer from a broken button. */}
            <button className="btn-sm" aria-expanded={drawerOpen} aria-controls={`roi-assumptions-${p.projectId}`}
                    onClick={() => { setOpenDrawer(drawerOpen ? null : p.projectId); setDrawerForm({}); }}>
              {drawerOpen ? 'Close assumptions' : 'Assumptions…'}
            </button>
            {drawerOpen && (
              <div id={`roi-assumptions-${p.projectId}`} role="region" aria-label={`${p.name} ROI assumptions`}
                   style={{ marginTop: 10 }}>
                <table className="data">
                  <thead><tr><th>Assumption</th><th className="num">Effective value</th>{isAdmin && <th>Override</th>}</tr></thead>
                  <tbody>
                    {[
                      ['teamSize', r.value.timeSaved.formulaInputs.teamSize],
                      ['loadedCostPerYear', r.value.timeSaved.formulaInputs.loadedCostPerYear],
                      ['netTimeSavedPct', r.value.timeSaved.formulaInputs.netTimeSavedPct],
                      ['revenueBase', r.value.throughput.formulaInputs.revenueBase],
                      ['downtimeCostPerHour', r.value.stabilityDelta.formulaInputs.downtimeCostPerHour ?? 100000],
                      ['trainingCostPerUser', r.investment.training.formulaInputs.trainingCostPerUser],
                    ].map(([k, v]) => (
                      <tr key={String(k)}>
                        <td className="mono" style={{ fontSize: 12 }}>{String(k)}</td>
                        <td className="num">{String(v ?? '—')} {p.assumptionsSource !== 'project' && <span className="badge neutral">{p.assumptionsSource}</span>}</td>
                        {isAdmin && (
                          <td className="num">
                            <input style={{ width: 110, padding: '4px 8px', border: '1px solid var(--border)', borderRadius: 6 }}
                                   value={drawerForm[String(k)] ?? ''} placeholder="keep"
                                   onChange={(e) => setDrawerForm({ ...drawerForm, [String(k)]: e.target.value })} />
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="muted" style={{ fontSize: 12, marginTop: 6 }}>{r.uncertainty.note}</p>
                {isAdmin && <button className="btn-primary" style={{ width: 'auto', padding: '8px 16px' }} onClick={() => saveAssumptions(p)}>Save overrides</button>}
              </div>
            )}
          </Panel>
        );
      })}

      {/* ---- portfolio quadrant (kill-fast view) ---- */}
      {withSpend.length > 1 && (
        <Panel title="Portfolio — spend vs delivery"
               desc="Bubble = |ROI%| where a composite was computable; projects whose ROI is refused plot at the base size. Red = review recommended (2 consecutive out-of-sample hot-cold weeks). A signal, never a gate.">
          <ResponsiveContainer width="100%" height={300}>
            <ScatterChart margin={{ left: 12, right: 20, top: 10, bottom: 4 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#eef2f7" />
              <XAxis type="number" dataKey="x" name="monthly spend" tickFormatter={(n: number) => fmtUsdK(n)} tick={{ fontSize: 12, fill: '#64748b' }} />
              <YAxis type="number" dataKey="y" name="merged PRs" tick={{ fontSize: 12, fill: '#64748b' }} allowDecimals={false} />
              <ZAxis type="number" dataKey="z" range={[80, 500]} />
              <Tooltip contentStyle={{ borderRadius: 10, border: '1px solid #e2e8f0', fontSize: 13 }}
                       formatter={(v: number, n: string) => n === 'monthly spend' ? fmtUsd(v) : v}
                       labelFormatter={() => ''} />
              <Scatter data={withSpend.map((p) => ({
                x: p.monthlySpendUsd, y: p.mergedPrs, z: Math.abs(p.roi.roiPct ?? 0) + 20, name: p.name, flagged: p.killFast.flagged,
              }))}>
                {withSpend.map((p, i) => <Cell key={i} fill={p.killFast.flagged ? '#dc2626' : '#6366f1'} fillOpacity={0.7} />)}
              </Scatter>
            </ScatterChart>
          </ResponsiveContainer>
        </Panel>
      )}

      {/* ---- forward estimator ---- */}
      <Panel title="Budget a new project" desc="Reference-class forecast from an existing project's own history — a band, not a promise.">
        <div className="inline-form" style={{ marginBottom: 10 }}>
          <select value={estRef} onChange={(e) => setEstRef(e.target.value)}
                  style={{ padding: '8px 12px', border: '1px solid var(--border)', borderRadius: 8, fontSize: 14 }}>
            {(rows ?? []).map((p) => <option key={p.projectId} value={p.projectId}>{p.name}</option>)}
          </select>
          <input value={estPrs} onChange={(e) => setEstPrs(e.target.value)} style={{ minWidth: 140 }} placeholder="expected PRs / month" aria-label="Expected PRs per month" />
          <button className="btn-primary" style={{ width: 'auto', padding: '8px 16px' }} onClick={runEstimate} disabled={estBusy || !estRef}>Estimate</button>
          {estErr && <span className="error-text" style={{ marginTop: 0 }}>{estErr}</span>}
        </div>
        {estOut && (
          <div className="kpi-grid">
            <Kpi label="Monthly budget band (P25–P50–P90)" value={estOut.budgetMonthlyUsd ? fmtUsdK(estOut.budgetMonthlyUsd.p50) : '—'}
                 accent="var(--primary)"
                 foot={estOut.budgetMonthlyUsd ? bandText(estOut.budgetMonthlyUsd, fmtUsdK) : estOut.notes.join(' ')} />
            <Kpi label="Projected break-even (P50)" value={estOut.projectedBreakEvenHoursPerMonth ? `${estOut.projectedBreakEvenHoursPerMonth.p50} h/mo` : '—'}
                 accent="var(--accent-blue)"
                 foot={estOut.pctOfCapacityP50 != null ? `${estOut.pctOfCapacityP50}% of team capacity at team=${estOut.teamSize}` : '—'} />
            <Kpi label="Reference" value={estOut.reference.name} foot={`${estOut.bands.weeks} weeks of history · ${estOut.prsPerMonth} PRs/mo assumed`} />
          </div>
        )}
      </Panel>

      <p className="muted" style={{ fontSize: 12 }}>
        AI-vs-human cohort comparisons live on the <a href="/dora">DORA page</a> and are <strong>observational</strong> —
        AI-assisted PRs are not a random sample of tasks, so cohort deltas are not causal. For causal claims, run a
        lightweight holdout (randomly assign AI access for a sprint and compare telemetry).
      </p>
    </>
  );
}
