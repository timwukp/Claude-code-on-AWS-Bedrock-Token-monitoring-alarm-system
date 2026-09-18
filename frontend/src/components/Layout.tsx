import { ReactNode } from 'react';
import { NavLink } from 'react-router-dom';
import { signOut } from '../auth/cognito';
import { HelpId, helpIdForLabel } from '../lib/help-content';
import { HelpButton, HelpPanel, HelpProvider } from './HelpPanel';
import { Icon, IconName } from './Icon';
import { KpiTile } from './KpiTile';
import { TimeRangePicker } from './TimeRangePicker';
import type { Window } from '../lib/time-range';

type NavItem = { to: string; label: string; icon: IconName; end?: boolean };
type NavGroup = { heading: string; items: NavItem[] };

const NAV_GROUPS: NavGroup[] = [
  {
    heading: 'Spend',
    items: [
      { to: '/', label: 'Usage', icon: 'usage', end: true },
      { to: '/costs', label: 'Cost', icon: 'cost' },
      { to: '/projects', label: 'By project', icon: 'project' },
    ],
  },
  {
    heading: 'Governance',
    items: [
      { to: '/governance', label: 'Budgets & guardrails', icon: 'shield' },
      { to: '/anomalies', label: 'Anomalies', icon: 'bell' },
    ],
  },
  {
    heading: 'Delivery',
    items: [
      { to: '/dora', label: 'DORA metrics', icon: 'rocket' },
      { to: '/roi', label: 'AI ROI', icon: 'trend' },
      { to: '/latency', label: 'Latency', icon: 'timer' },
    ],
  },
];

/** App shell: dark sidebar with grouped navigation, top bar, content area, and the help rail. */
export function Layout({ title, subtitle, user, windows, fixedCaption, children }: {
  title: string; subtitle?: string; user?: string | null;
  /** Windows the current page can honour; `[]` = fixed period (caption only); omit = no picker. */
  windows?: readonly Window[]; fixedCaption?: string; children: ReactNode;
}) {
  return (
    <HelpProvider>
      <div className="app-shell">
        <aside className="sidebar">
          <div className="brand">
            <span className="brand-mark" aria-hidden="true">TM</span>
            <span className="brand-name">TokenMonitor</span>
          </div>
          <nav className="nav" aria-label="Primary">
            {NAV_GROUPS.map((g) => (
              <div className="nav-group" key={g.heading}>
                <div className="nav-section">{g.heading}</div>
                {g.items.map((n) => (
                  <NavLink key={n.to} to={n.to} end={n.end}
                    className={({ isActive }) => 'nav-link' + (isActive ? ' active' : '')}>
                    <Icon name={n.icon} size={17} className="ico" />
                    <span>{n.label}</span>
                  </NavLink>
                ))}
              </div>
            ))}
          </nav>
          <div className="sidebar-footer">
            {user && (
              <div className="user" title={user}>
                <Icon name="user" size={15} />
                <span className="user-name">{user}</span>
              </div>
            )}
            <button className="btn-ghost" onClick={() => signOut().then(() => location.reload())}>
              <Icon name="logout" size={15} />
              Sign out
            </button>
          </div>
        </aside>
        <div className="main">
          <header className="topbar">
            <div>
              <h1>{title}</h1>
              {subtitle && <div className="sub">{subtitle}</div>}
            </div>
            {windows && <TimeRangePicker supported={windows} fixedCaption={fixedCaption} />}
          </header>
          <div className="content">{children}</div>
        </div>
        <HelpPanel />
      </div>
    </HelpProvider>
  );
}

/**
 * One measurement per card: a label, at most one qualifier `chip`, one number, and one line of
 * `foot` provenance saying what was counted. Renders through `KpiTile`; a card whose label has a
 * help entry gains an info button automatically, so definitions leave the card face without any
 * page edit. Definitions belong in the help panel (or a `Disclosure`), not here.
 */
export function Kpi({ label, value, accent, chip, foot, helpId }: {
  label: string; value: string; accent?: string; chip?: ReactNode; foot?: ReactNode; helpId?: HelpId;
}) {
  return (
    <KpiTile label={label} value={value} accent={accent} chip={chip} definition={foot}
      helpId={helpId ?? helpIdForLabel(label)} />
  );
}

/**
 * Progressive disclosure on native `<details>/<summary>`, so it opens by keyboard and by touch
 * with no ARIA wiring and no hover dependency — a hover-only tooltip cannot carry information a
 * reader needs (NN/g; WCAG 1.4.13). `open` seeds the initial state only; the element owns it after.
 */
export function Disclosure({ summary, open, children }: {
  summary: string; open?: boolean; children: ReactNode;
}) {
  return (
    <details className="disclosure" open={open}>
      <summary>{summary}</summary>
      <div className="disclosure-body">{children}</div>
    </details>
  );
}

export function Panel({ title, desc, helpId, children }: { title: string; desc?: string; helpId?: HelpId; children: ReactNode }) {
  return (
    <div className="panel">
      <div className="panel-head">
        <h2>{title}{helpId && <HelpButton id={helpId} label={title} className="panel-help" />}</h2>
        {desc && <div className="desc">{desc}</div>}
      </div>
      <div className="panel-body">{children}</div>
    </div>
  );
}
