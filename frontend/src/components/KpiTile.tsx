import { ReactNode } from 'react';
import { Area, AreaChart, ResponsiveContainer } from 'recharts';
import { Link } from 'react-router-dom';
import { MARK, series } from '../charts/theme';
import { HelpId } from '../lib/help-content';
import { HelpButton } from './HelpPanel';
import { Icon } from './Icon';

/**
 * The full stat-tile anatomy: label · one-line definition · value · delta against a NAMED period ·
 * optional sparkline · optional status chip · an info button · optional link. Proportional figures
 * on the value (tabular digits belong in tables, not on a hero number).
 */

export type Tone = 'ok' | 'warn' | 'serious' | 'danger' | 'info' | 'neutral';

export interface KpiDelta {
  value: number;
  unit: 'pct' | 'usd' | 'abs';
  compareLabel: string;
  goodDirection?: 'up' | 'down' | 'neutral';
}

export interface KpiTileProps {
  label: string;
  value: ReactNode;
  definition?: ReactNode;
  delta?: KpiDelta;
  sparkline?: number[];
  status?: { tone: Tone; text: string };
  helpId?: HelpId;
  link?: { to: string; label?: string };
  state?: 'ready' | 'loading' | 'error' | 'empty';
  stateText?: string;
  accent?: string;
  chip?: ReactNode;
}

const TONE_ICON: Record<Tone, 'check' | 'alert' | 'info'> = { ok: 'check', warn: 'alert', serious: 'alert', danger: 'alert', info: 'info', neutral: 'info' };

function fmtDelta(d: KpiDelta): string {
  const sign = d.value > 0 ? '+' : d.value < 0 ? '−' : '';
  const v = Math.abs(d.value);
  if (d.unit === 'pct') return `${sign}${v.toFixed(v >= 10 ? 0 : 1)}%`;
  if (d.unit === 'usd') return `${sign}$${v.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
  return `${sign}${v.toLocaleString('en-US', { maximumFractionDigits: 1 })}`;
}

function deltaTone(d: KpiDelta): 'good' | 'bad' | 'flat' {
  if (d.value === 0 || d.goodDirection === 'neutral' || !d.goodDirection) return 'flat';
  const up = d.value > 0;
  return (up && d.goodDirection === 'up') || (!up && d.goodDirection === 'down') ? 'good' : 'bad';
}

export function KpiTile(p: KpiTileProps) {
  const state = p.state ?? 'ready';
  const tone = p.delta ? deltaTone(p.delta) : 'flat';
  return (
    <div className={`kpi kpi-tile state-${state}`}>
      <div className="label">
        {p.accent && <span className="dot" style={{ background: p.accent }} />}
        <span className="kpi-label-text">{p.label}</span>
        {p.chip}
        {p.helpId && <HelpButton id={p.helpId} label={p.label} className="kpi-help" />}
      </div>

      {state === 'loading' && <div className="value kpi-skeleton" aria-busy="true">&nbsp;</div>}
      {state === 'error' && <div className="kpi-state danger"><Icon name="alert" size={14} /> {p.stateText ?? 'Unavailable'}</div>}
      {state === 'empty' && <div className="kpi-state"><Icon name="info" size={14} /> {p.stateText ?? 'No data in this window'}</div>}
      {state === 'ready' && (
        <div className="kpi-row">
          <div className="value">{p.value}</div>
          {p.sparkline && p.sparkline.length > 1 && (
            <div className="kpi-spark" aria-hidden="true">
              <ResponsiveContainer width="100%" height={28}>
                <AreaChart data={p.sparkline.map((v, i) => ({ i, v }))} margin={{ top: 2, right: 0, bottom: 0, left: 0 }}>
                  <Area type="monotone" dataKey="v" stroke={series()[0]} fill={series()[0]} strokeWidth={1.5}
                    fillOpacity={MARK.area.fillOpacity} isAnimationActive={false} dot={false}
                    activeDot={false} baseValue="dataMin" />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>
      )}

      {state === 'ready' && p.delta && (
        <div className={`kpi-delta ${tone}`}
          aria-label={`${p.delta.value > 0 ? 'up' : p.delta.value < 0 ? 'down' : 'unchanged'} ${fmtDelta(p.delta).replace(/^[+−]/, '')} ${p.delta.compareLabel}`}>
          <span className="kpi-arrow" aria-hidden="true">{p.delta.value > 0 ? '▲' : p.delta.value < 0 ? '▼' : '■'}</span>
          <span>{fmtDelta(p.delta)}</span>
          <span className="muted">{p.delta.compareLabel}</span>
        </div>
      )}

      {(p.definition || p.status || p.link) && (
        <div className="kpi-foot">
          {p.status && (
            <span className={`badge ${p.status.tone === 'ok' ? 'success' : p.status.tone === 'warn' || p.status.tone === 'serious' ? 'warning' : p.status.tone === 'danger' ? 'critical' : p.status.tone === 'info' ? 'info' : 'neutral'}`}>
              <Icon name={TONE_ICON[p.status.tone]} size={11} /> {p.status.text}
            </span>
          )}
          {p.definition && <span className="delta muted">{p.definition}</span>}
          {p.link && <Link className="kpi-link" to={p.link.to}>{p.link.label ?? 'View all'} <Icon name="chevron" size={12} /></Link>}
        </div>
      )}
    </div>
  );
}
