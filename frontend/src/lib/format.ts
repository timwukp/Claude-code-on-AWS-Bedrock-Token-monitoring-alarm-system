/** Shared formatting helpers for the dashboard. */
export const fmtUsd = (n: number): string => `$${n.toFixed(2)}`;

export const fmtTokens = (n: number): string =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(2)}M`
  : n >= 1_000 ? `${(n / 1_000).toFixed(1)}k`
  : n === 0 ? '0k' // chart axis origin: a bare '0' reads as a stray character (QA finding)
  : String(n);
