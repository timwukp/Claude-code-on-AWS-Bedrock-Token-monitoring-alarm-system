import { createContext, ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { HELP, HelpEntry, HelpId } from '../lib/help-content';
import { Icon } from './Icon';

/**
 * Progressive disclosure for definitions: a visible one-line caption stays on the card; the full
 * "what / why / how / caveats / learn more" lives here, opened by a real button (keyboard, touch,
 * mouse alike). On wide viewports it is a non-modal right rail so the chart stays readable next to
 * its definition; on narrow ones it becomes a modal dialog with a focus trap.
 */

interface HelpRuntime { notes?: string[] }
interface HelpCtx {
  current: HelpId | null;
  runtime: HelpRuntime | undefined;
  open: (id: HelpId, runtime?: HelpRuntime) => void;
  close: () => void;
}
const Ctx = createContext<HelpCtx | null>(null);

export function useHelp(): HelpCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error('useHelp must be used inside <HelpProvider>');
  return c;
}

export function HelpProvider({ children }: { children: ReactNode }) {
  const [current, setCurrent] = useState<HelpId | null>(null);
  const [runtime, setRuntime] = useState<HelpRuntime | undefined>();
  const opener = useRef<HTMLElement | null>(null);

  const open = useCallback((id: HelpId, rt?: HelpRuntime) => {
    opener.current = document.activeElement as HTMLElement | null;
    setRuntime(rt); setCurrent(id);
  }, []);
  const close = useCallback(() => {
    setCurrent(null); setRuntime(undefined);
    const el = opener.current; opener.current = null;
    if (el && typeof el.focus === 'function') requestAnimationFrame(() => el.focus());
  }, []);

  const value = useMemo(() => ({ current, runtime, open, close }), [current, runtime, open, close]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function HelpButton({ id, label, runtime, className }: { id: HelpId; label: string; runtime?: HelpRuntime; className?: string }) {
  const { open } = useHelp();
  return (
    <button type="button" className={`help-btn${className ? ' ' + className : ''}`} aria-label={`About ${label}`}
      onClick={() => open(id, runtime)}>
      <Icon name="info" size={14} />
    </button>
  );
}

function useIsWide(bp = 1100): boolean {
  const [wide, setWide] = useState(() => typeof window !== 'undefined' && window.innerWidth >= bp);
  useEffect(() => {
    const mq = window.matchMedia(`(min-width: ${bp}px)`);
    const on = () => setWide(mq.matches);
    on(); mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, [bp]);
  return wide;
}

export function HelpPanel() {
  const { current, runtime, close } = useHelp();
  const wide = useIsWide();
  const panel = useRef<HTMLElement | null>(null);
  const entry: HelpEntry | null = current ? HELP[current] : null;

  useEffect(() => {
    if (!entry) return;
    const first = panel.current?.querySelector<HTMLElement>('button, a[href]');
    first?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); close(); return; }
      if (e.key === 'Tab' && !wide && panel.current) {
        const nodes = panel.current.querySelectorAll<HTMLElement>('button, a[href], [tabindex]:not([tabindex="-1"])');
        if (!nodes.length) return;
        const firstN = nodes[0], lastN = nodes[nodes.length - 1];
        if (e.shiftKey && document.activeElement === firstN) { e.preventDefault(); lastN.focus(); }
        else if (!e.shiftKey && document.activeElement === lastN) { e.preventDefault(); firstN.focus(); }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [entry, wide, close]);

  if (!entry || !current) return null;
  const caveats = [...(entry.caveats ?? []), ...(runtime?.notes ?? [])];
  const titleId = `help-title-${current}`;

  const body = (
    <aside ref={panel} className={`help-panel ${wide ? 'help-rail' : 'help-modal'}`} role="dialog"
      aria-modal={wide ? undefined : true} aria-labelledby={titleId}>
      <header className="help-head">
        <h2 id={titleId}>{entry.title}</h2>
        <button type="button" className="help-close" aria-label="Close help" onClick={close}><Icon name="close" size={16} /></button>
      </header>
      <section><h3>What is this?</h3><p>{entry.what}</p></section>
      <section><h3>Why it matters</h3><p>{entry.why}</p></section>
      <section><h3>How it’s calculated</h3><p>{entry.how}</p></section>
      {caveats.length > 0 && (
        <section><h3>Caveats</h3><ul>{caveats.map((c, i) => <li key={i}>{c}</li>)}</ul></section>
      )}
      {entry.docs && (
        <section className="help-docs">
          <a href={entry.docs.href} target="_blank" rel="noreferrer">{entry.docs.label} <Icon name="external" size={12} /></a>
        </section>
      )}
    </aside>
  );

  return wide ? body : (
    <div className="help-backdrop" onClick={(e) => { if (e.target === e.currentTarget) close(); }}>{body}</div>
  );
}
