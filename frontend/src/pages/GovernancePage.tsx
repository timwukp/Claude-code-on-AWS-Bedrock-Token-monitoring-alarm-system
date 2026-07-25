import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { Kpi, Panel } from '../components/Layout';
import { fmtUsd } from '../lib/format';

/**
 * Cost-governance posture: Bedrock budget (limit / actual / forecast) and the enforcement
 * guardrails (Budget Action hard-stop + per-principal containment) — read-only, so operators
 * see the controls without opening the AWS console. Backed by GET /v1/governance (#4/#5).
 */
export function GovernancePage() {
  const [data, setData] = useState<{ budget: any; enforcement: any } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.governance().then(setData).catch((e) => setError(String(e))).finally(() => setLoading(false));
  }, []);

  if (loading) return <div className="empty"><span className="spinner" /></div>;
  if (error) return <div className="empty"><div className="big">⚠️</div>Failed to load: {error}</div>;

  const b = data?.budget;
  const e = data?.enforcement ?? {};
  const enforceMode = e.mode === 'enforce';

  return (
    <>
      <div className="kpi-grid">
        <Kpi label="Monthly budget" value={b?.limitUsd ? fmtUsd(b.limitUsd) : '—'} accent="var(--primary)" />
        <Kpi label="Actual spend" value={b?.actualUsd ? fmtUsd(b.actualUsd) : '—'}
             accent="var(--accent-blue)" foot={b?.actualPct != null ? `${b.actualPct}% of budget` : undefined} />
        <Kpi label="Forecasted spend" value={b?.forecastedUsd ? fmtUsd(b.forecastedUsd) : '—'}
             accent="var(--accent-amber)" foot={b?.forecastedPct != null ? `${b.forecastedPct}% of budget` : undefined} />
        <Kpi label="Enforcement mode" value={enforceMode ? 'Enforce' : 'Notify-only'}
             accent={enforceMode ? 'var(--danger)' : 'var(--accent-green)'} />
      </div>

      <Panel title="Cost guardrails" desc="Spend caps and automated containment posture">
        <table className="data">
          <tbody>
            <tr>
              <td><strong>Budget Action hard-stop</strong><div className="muted" style={{ fontSize: 12 }}>
                Auto-applies a deny-Bedrock policy at a spend threshold.</div></td>
              <td className="num">
                <span className={`badge ${e.budgetActionArmed ? 'warning' : 'info'}`}>
                  {e.budgetActionArmed ? `armed @ ${e.budgetActionThresholdPct}%` : 'not armed'}
                </span>
              </td>
            </tr>
            <tr>
              <td><strong>Per-principal auto-containment</strong><div className="muted" style={{ fontSize: 12 }}>
                Attaches a deny policy to an offending IAM principal on AccessDenied.</div></td>
              <td className="num">
                <span className={`badge ${e.autoContainment ? 'critical' : 'info'}`}>
                  {e.autoContainment ? 'enabled' : 'notify-only (default)'}
                </span>
              </td>
            </tr>
          </tbody>
        </table>
        {b?.error && <p className="muted" style={{ marginTop: 12 }}>Budget: {b.error}</p>}
        <p className="muted" style={{ marginTop: 12, fontSize: 12 }}>
          Guardrails are off by default (Security pillar). See docs/GOVERNANCE_FAQ.md and
          docs/ROADMAP.md (#4/#5). Bedrock has no consumer-style timer-reset quota; the hard stop
          here is a Budget Action that freezes access at a spend cap.
        </p>
      </Panel>
    </>
  );
}
