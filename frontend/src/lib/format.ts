/** Shared formatting helpers for the dashboard. */

/** USD with thousands separators and exactly 2 decimals: "$13,858.35".
 *
 * The locale is pinned rather than left to the browser (qa F-1102 was the missing separator;
 * an unpinned locale is the same bug's mirror image — a de-DE reader would see "$13.858,35"
 * for a figure the rest of the page states in en-US form). */
// Sign before the currency symbol: a negative cache-net read "$-0.19" (qa F-PR72 round 3). A value that rounds
// to -0.00 is shown as $0.00, not "−$0.00".
export const fmtUsd = (n: number): string => {
  const abs = Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${n < 0 && abs !== '0.00' ? '−' : ''}$${abs}`;
};

/** Token counts: "842" / "12.3k" / "9.38M" / "16.22B" / "1.04T".
 *
 * Scaling runs to T, not just M (qa F-1201 and five later recurrences: a cache-read total rendered
 * as "16215.23M" — four digits of mantissa, no separator). Stopping at any one unit only moves that
 * bug three orders up and waits, so every tier a cumulative counter can reach is covered. The
 * locale is pinned for the same reason `fmtUsd` pins it — the rest of the page states figures in
 * en-US form, so a browser default would disagree with itself. */
export const fmtTokens = (n: number): string => {
  const scaled = (v: number, unit: string): string =>
    `${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}${unit}`;
  if (n >= 1e12) return scaled(n / 1e12, 'T');
  if (n >= 1_000_000_000) return scaled(n / 1_000_000_000, 'B');
  if (n >= 1_000_000) return scaled(n / 1_000_000, 'M');
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
};

/** Plain integer with en-US grouping: 71,282 (counts that are not token volumes). */
export const fmtInt = (n: number): string => Math.round(n).toLocaleString('en-US');

/** Axis-tick variant: hides the origin label — a lone '0' floating under a chart reads as a
 * stray character (recurring QA finding); standard practice is to omit the origin tick. */
export const fmtAxisTokens = (n: number): string => (n === 0 ? '' : fmtTokens(n));

/** Duration in hours → "42 min" / "5.3 h" / "3.1 d"; null → "—". */
export const fmtHours = (h: number | null | undefined): string => {
  if (h == null || !Number.isFinite(h)) return '—';
  if (h < 1) return `${Math.round(h * 60)} min`;
  if (h < 48) return `${h.toFixed(1)} h`;
  return `${(h / 24).toFixed(1)} d`;
};

/** Percent with one decimal; null → "—". */
export const fmtPct = (n: number | null | undefined): string =>
  n == null || !Number.isFinite(n) ? '—' : `${Math.round(n * 10) / 10}%`;

/** Axis-tick variant for hour values (hides the origin tick, see fmtAxisTokens). */
export const fmtAxisHours = (h: number): string => (h === 0 ? '' : h >= 48 ? `${Math.round(h / 24)}d` : `${Math.round(h)}h`);

/**
 * Axis ticks for a duration-in-hours series, in ONE unit. Recharts picks "nice" ticks in the data's
 * unit (25, 50, 75, 100 h), and a per-tick formatter then prints "25h, 2d, 3d, 4d" — mixed units and
 * an odd first tick (qa F-PR69-003). So when the series reaches two days the ticks are placed at
 * whole-day multiples and every label is in days; below that, whole hours.
 */
export function hourAxis(maxHours: number): { ticks: number[]; tickFormatter: (h: number) => string; domain: [number, number] } {
  const max = Math.max(0, maxHours);
  if (max >= 48) {
    const days = max / 24;
    const step = days <= 6 ? 1 : days <= 14 ? 2 : days <= 35 ? 7 : 14; // whole days per tick
    const top = Math.ceil(days / step) * step;
    const ticks: number[] = []; for (let d = 0; d <= top; d += step) ticks.push(d * 24);
    return { ticks, domain: [0, top * 24], tickFormatter: (h) => (h === 0 ? '' : `${Math.round(h / 24)}d`) };
  }
  const step = max <= 6 ? 1 : max <= 12 ? 2 : max <= 24 ? 4 : 12;
  const top = Math.max(step, Math.ceil(max / step) * step);
  const ticks: number[] = []; for (let h = 0; h <= top; h += step) ticks.push(h);
  return { ticks, domain: [0, top], tickFormatter: (h) => (h === 0 ? '' : `${h}h`) };
}

/** ISO timestamp → "2026-09-16 09:30" (UTC, as the API returns). */
export const fmtDateTime = (iso: string | null | undefined): string => (iso ? iso.slice(0, 16).replace('T', ' ') : '—');

/** "3 minutes ago" style relative time for sync status lines. */
export const fmtAgo = (iso: string | null | undefined, now = Date.now()): string => {
  if (!iso) return 'never';
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
};

/** Signed USD for waterfall labels: -$1,234 / +$1,234. */
export const fmtSignedUsd = (n: number): string =>
  `${n < 0 ? '−' : '+'}$${Math.abs(Math.round(n)).toLocaleString('en-US')}`;

/** Compact USD: $12.3K / $1.2M. */
export const fmtUsdK = (n: number): string => {
  const a = Math.abs(n); const sign = n < 0 ? '−' : '';
  if (a >= 1_000_000) return `${sign}$${(a / 1_000_000).toFixed(1)}M`;
  if (a >= 1_000) return `${sign}$${(a / 1_000).toFixed(1)}K`;
  return `${sign}$${a.toFixed(0)}`;
};
