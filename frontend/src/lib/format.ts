/** Shared formatting helpers for the dashboard. */
export const fmtUsd = (n: number): string => `$${n.toFixed(2)}`;

export const fmtTokens = (n: number): string =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(2)}M` : n >= 1_000 ? `${(n / 1_000).toFixed(1)}k` : String(n);

/** Axis-tick variant: hides the origin label — a lone '0' floating under a chart reads as a
 * stray character (recurring QA finding); standard practice is to omit the origin tick. */
export const fmtAxisTokens = (n: number): string => (n === 0 ? '' : fmtTokens(n));
