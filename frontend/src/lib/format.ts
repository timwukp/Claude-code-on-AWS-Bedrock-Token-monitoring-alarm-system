/** Shared formatting helpers for the dashboard. */
export const fmtUsd = (n: number): string => `$${n.toFixed(2)}`;

export const fmtTokens = (n: number): string =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(2)}M` : n >= 1_000 ? `${(n / 1_000).toFixed(1)}k` : String(n);

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
export const fmtSignedUsd = (n: number): string => `${n < 0 ? '−' : '+'}$${Math.abs(Math.round(n)).toLocaleString()}`;

/** Compact USD: $12.3K / $1.2M. */
export const fmtUsdK = (n: number): string => {
  const a = Math.abs(n); const sign = n < 0 ? '−' : '';
  if (a >= 1_000_000) return `${sign}$${(a / 1_000_000).toFixed(1)}M`;
  if (a >= 1_000) return `${sign}$${(a / 1_000).toFixed(1)}K`;
  return `${sign}$${a.toFixed(0)}`;
};
