import { useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';

/**
 * One time range for the whole portal, carried in the URL (`?window=`) so a link reproduces what
 * the reader saw. Pages declare which windows they can honour; a request they cannot honour is
 * coerced to the nearest one they can, and the page says so.
 */

export type Window = 7 | 30 | 90 | 'mtd';
export const ALL_WINDOWS: readonly Window[] = [7, 30, 90, 'mtd'];
export const DEFAULT_WINDOW: Window = 30;

export const WINDOW_LABEL: Record<Window, string> = { 7: 'Last 7 days', 30: 'Last 30 days', 90: 'Last 90 days', mtd: 'Month to date' };
export const WINDOW_SHORT: Record<Window, string> = { 7: '7d', 30: '30d', 90: '90d', mtd: 'MTD' };

export function parseWindow(raw: string | null | undefined): Window | null {
  if (raw === 'mtd') return 'mtd';
  const n = Number(raw);
  return n === 7 || n === 30 || n === 90 ? (n as Window) : null;
}

/** Nearest supported window for a request the page cannot honour. */
export function coerceWindow(requested: Window, supported: readonly Window[]): Window {
  if (supported.includes(requested)) return requested;
  const order: Window[] = requested === 'mtd' ? [30, 90, 7] : requested === 7 ? [30, 90, 'mtd'] : requested === 90 ? [30, 7, 'mtd'] : [90, 7, 'mtd'];
  return order.find((w) => supported.includes(w)) ?? supported[0] ?? DEFAULT_WINDOW;
}

export function windowBounds(w: Window, now = new Date()): { fromIso: string; toIso: string; days: number } {
  const to = new Date(now);
  const from = new Date(now);
  if (w === 'mtd') {
    from.setUTCDate(1); from.setUTCHours(0, 0, 0, 0);
  } else {
    from.setTime(to.getTime() - w * 86_400_000);
  }
  const days = Math.max(1, Math.round((to.getTime() - from.getTime()) / 86_400_000));
  return { fromIso: from.toISOString(), toIso: to.toISOString(), days };
}

export interface TimeRange {
  /** The window this page is actually showing. */
  window: Window;
  /** The window the URL asked for, when the page had to coerce it; else null. */
  coercedFrom: Window | null;
  requested: Window;
  days: number;
  fromIso: string;
  toIso: string;
  label: string;
  setWindow: (w: Window) => void;
  supported: readonly Window[];
}

export function useTimeRange(supported: readonly Window[] = ALL_WINDOWS): TimeRange {
  const [params, setParams] = useSearchParams();
  const requested = parseWindow(params.get('window')) ?? DEFAULT_WINDOW;
  const window = supported.length ? coerceWindow(requested, supported) : requested;
  const setWindow = useCallback((w: Window) => {
    setParams((p) => { p.set('window', String(w)); return p; }, { replace: true });
  }, [setParams]);
  // Anchor "now" to the minute so the ISO bounds are referentially stable across renders —
  // a fresh Date() per render would change fromIso/toIso every time and refire every fetch effect.
  const nowMinute = Math.floor(Date.now() / 60_000) * 60_000;
  const supportedKey = supported.join(',');
  return useMemo(() => {
    const b = windowBounds(window, new Date(nowMinute));
    return {
      window, requested, coercedFrom: window === requested ? null : requested,
      ...b, label: WINDOW_LABEL[window], setWindow, supported,
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- supported is keyed by value
  }, [window, requested, setWindow, supportedKey, nowMinute]);
}
