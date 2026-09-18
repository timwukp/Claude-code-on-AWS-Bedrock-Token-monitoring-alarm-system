import { ReactNode } from 'react';
import { NavLink } from 'react-router-dom';
import { signOut } from '../auth/cognito';

const NAV = [
  { to: '/', label: 'Usage', ico: '📊', end: true },
  { to: '/costs', label: 'Cost', ico: '💰' },
  { to: '/projects', label: 'By Project', ico: '🗂️' },
  { to: '/governance', label: 'Governance', ico: '🛡️' },
  { to: '/anomalies', label: 'Anomalies', ico: '🔔' },
  { to: '/dora', label: 'DORA', ico: '🚀' },
  { to: '/roi', label: 'ROI', ico: '📈' },
];

/** App shell: dark sidebar + topbar + content area. */
export function Layout({ title, subtitle, user, children }: {
  title: string; subtitle?: string; user?: string | null; children: ReactNode;
}) {
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-logo">◆</span>
          <span>TokenMonitor</span>
        </div>
        <div className="nav-section">Monitoring</div>
        {NAV.map((n) => (
          <NavLink key={n.to} to={n.to} end={n.end}
            className={({ isActive }) => 'nav-link' + (isActive ? ' active' : '')}>
            <span className="ico">{n.ico}</span>{n.label}
          </NavLink>
        ))}
        <div className="sidebar-footer">
          {user && <div className="user" title={user}>👤 {user}</div>}
          <button className="btn-ghost" onClick={() => signOut().then(() => location.reload())}>
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
        </header>
        <div className="content">{children}</div>
      </div>
    </div>
  );
}

/**
 * One measurement per card: a label, at most one qualifier `chip`, one number, and one line of
 * `foot` provenance saying what was counted. Definitions belong in a `Disclosure`, not here — a
 * card that carries its own caveats stops being scannable.
 */
export function Kpi({ label, value, accent, chip, foot }: {
  label: string; value: string; accent?: string; chip?: ReactNode; foot?: ReactNode;
}) {
  return (
    <div className="kpi">
      <div className="label">
        {accent && <span className="dot" style={{ background: accent }} />}{label}
        {chip}
      </div>
      <div className="value">{value}</div>
      {foot && <div className="delta muted">{foot}</div>}
    </div>
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

export function Panel({ title, desc, children }: { title: string; desc?: string; children: ReactNode }) {
  return (
    <div className="panel">
      <div className="panel-head"><h2>{title}</h2>{desc && <div className="desc">{desc}</div>}</div>
      <div className="panel-body">{children}</div>
    </div>
  );
}
