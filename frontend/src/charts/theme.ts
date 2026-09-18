import type { ModelFamily } from '../lib/model-names';
import { parseModelId } from '../lib/model-names';

/**
 * One chart theme for every Recharts usage. Hex values mirror the CSS tokens in styles.css 1:1
 * (SVG presentation attributes are more reliable with literals than with var()). The categorical
 * palette is validated for colour-vision separation on both surfaces (see
 * docs/research-dashboard-ux.md / the ux-foundation test report); slots are assigned per entity,
 * never per rank, so filtering never repaints a survivor.
 */

export type Theme = 'dark' | 'light';

export function currentTheme(): Theme {
  if (typeof document === 'undefined') return 'dark';
  return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
}

const SERIES_DARK = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'] as const;
const SERIES_LIGHT = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7', '#e34948'] as const;

const CHROME = {
  dark: { grid: '#1e293b', axis: '#273449', tick: '#94a3b8', surface: '#111a2e', muted: '#475569', text: '#e6edf7', divergeMid: '#383835' },
  light: { grid: '#eef2f7', axis: '#e2e8f0', tick: '#64748b', surface: '#ffffff', muted: '#94a3b8', text: '#0f172a', divergeMid: '#f0efec' },
} as const;

export function series(theme: Theme = currentTheme()): readonly string[] {
  return theme === 'light' ? SERIES_LIGHT : SERIES_DARK;
}
export function chrome(theme: Theme = currentTheme()) {
  return CHROME[theme];
}

/** Fixed slot per entity. Slot indices are 0-based into series(). */
export const MODEL_SLOT: Record<ModelFamily, number | null> = {
  'claude-opus': 0, 'claude-sonnet': 2, 'claude-haiku': 3, 'claude-fable': 6,
  nova: 1, openai: 4, llama: 5, mistral: 7, deepseek: 5, kimi: 7, other: null,
};
export function colorForModel(modelId: string, theme: Theme = currentTheme()): string {
  const slot = MODEL_SLOT[parseModelId(modelId).family];
  return slot == null ? chrome(theme).muted : series(theme)[slot];
}

/** Named roles used by specific charts. */
export function role(name: 'human' | 'ai' | 'input' | 'output' | 'cache' | 'positive' | 'negative' | 'subtotal', theme: Theme = currentTheme()): string {
  const s = series(theme);
  switch (name) {
    case 'human': case 'input': case 'positive': return s[0];
    case 'ai': return s[1];
    case 'output': return s[2];
    case 'cache': return s[6];
    case 'negative': return s[7];
    case 'subtotal': return chrome(theme).muted;
  }
}

/** Mark specs: thin marks, rounded data-ends, flat area wash. */
export const MARK = {
  bar: { maxBarSize: 24, radius: [4, 4, 0, 0] as [number, number, number, number] },
  barStackedBottom: { maxBarSize: 24, radius: [0, 0, 0, 0] as [number, number, number, number] },
  line: { strokeWidth: 2, dot: false as const, activeDot: { r: 4, strokeWidth: 2 } },
  area: { strokeWidth: 2, fillOpacity: 0.1 },
  dot: { r: 4 },
} as const;

/** Prop bundles for Recharts primitives. Spread them: <CartesianGrid {...gridProps()} /> */
export function gridProps(theme: Theme = currentTheme()) {
  return { stroke: chrome(theme).grid, strokeDasharray: undefined, vertical: false } as const;
}
export function xAxisProps(theme: Theme = currentTheme()) {
  const c = chrome(theme);
  return { tick: { fontSize: 12, fill: c.tick }, tickLine: false, axisLine: { stroke: c.axis }, minTickGap: 40 } as const;
}
export function yAxisProps(tickFormatter?: (n: number) => string, theme: Theme = currentTheme()) {
  const c = chrome(theme);
  return { tick: { fontSize: 12, fill: c.tick }, tickLine: false, axisLine: false, tickFormatter } as const;
}
export function tooltipProps(theme: Theme = currentTheme()) {
  const c = chrome(theme);
  return {
    contentStyle: { background: c.surface, border: `1px solid ${c.axis}`, borderRadius: 8, fontSize: 13, color: c.text },
    labelStyle: { color: c.text, fontWeight: 600 },
    itemStyle: { color: c.tick },
    cursor: { stroke: c.axis },
  } as const;
}
export function legendProps() {
  return { iconType: 'circle' as const, iconSize: 8, wrapperStyle: { fontSize: 13 } };
}
/** 2 px surface gap between stacked segments / adjacent bars — the separator, instead of a stroke. */
export function surfaceGap(theme: Theme = currentTheme()) {
  return { stroke: chrome(theme).surface, strokeWidth: 2 } as const;
}
