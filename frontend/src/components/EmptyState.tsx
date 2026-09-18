import { Link } from 'react-router-dom';
import { Icon, IconName } from './Icon';

/**
 * A panel with nothing to show still has to say two things: what the system's state is, and what
 * would change it. Never a blank area, never an emoji.
 */
export function EmptyState({ kind, title, detail, action, icon }: {
  kind: 'loading' | 'empty' | 'error';
  title: string;
  detail?: string;
  action?: { label: string; to?: string; onClick?: () => void };
  icon?: IconName;
}) {
  const glyph = kind === 'loading'
    ? <span className="spinner" aria-hidden="true" />
    : <Icon name={kind === 'error' ? 'alert' : (icon ?? 'info')} size={22} />;
  return (
    <div className={`empty-state ${kind}`} role={kind === 'error' ? 'alert' : 'status'}>
      <div className="empty-state-glyph">{glyph}</div>
      <div className="empty-state-title">{title}</div>
      {detail && <div className="empty-state-detail">{detail}</div>}
      {action && (
        action.to
          ? <Link className="btn-sm" to={action.to}>{action.label}</Link>
          : <button className="btn-sm" type="button" onClick={action.onClick}>{action.label}</button>
      )}
    </div>
  );
}
