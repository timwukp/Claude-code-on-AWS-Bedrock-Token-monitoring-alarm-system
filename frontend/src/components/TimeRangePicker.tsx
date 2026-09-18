import { ALL_WINDOWS, useTimeRange, Window, WINDOW_LABEL, WINDOW_SHORT } from '../lib/time-range';

/**
 * The one range control, in the top bar. `supported` comes from the current page: windows it cannot
 * honour render disabled with a tooltip-free caption underneath, so the reader is never shown a
 * range the numbers below do not use. An empty `supported` means the page has a fixed period
 * (e.g. AWS Budgets' month-to-date) and the control turns into a caption.
 */
export function TimeRangePicker({ supported, fixedCaption }: { supported: readonly Window[]; fixedCaption?: string }) {
  const range = useTimeRange(supported.length ? supported : ALL_WINDOWS);
  if (!supported.length) {
    return <div className="range-caption" aria-live="polite">{fixedCaption ?? 'Fixed period'}</div>;
  }
  return (
    <div className="range-picker">
      <div className="seg seg-sm" role="group" aria-label="Time range">
        {ALL_WINDOWS.map((w) => {
          const ok = supported.includes(w);
          return (
            <button key={String(w)} type="button" disabled={!ok}
              className={range.window === w ? 'active' : ''}
              aria-pressed={range.window === w}
              aria-label={WINDOW_LABEL[w] + (ok ? '' : ' (not available on this page)')}
              onClick={() => range.setWindow(w)}>
              {WINDOW_SHORT[w]}
            </button>
          );
        })}
      </div>
      <div className="range-caption" aria-live="polite">
        {range.label}
        {range.coercedFrom && <span className="muted"> · {WINDOW_LABEL[range.coercedFrom].toLowerCase()} not available here</span>}
      </div>
    </div>
  );
}
