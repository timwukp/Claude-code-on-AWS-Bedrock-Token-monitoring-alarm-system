import { ReactNode, useId, useState } from 'react';

export interface ChartTableColumn<T> {
  header: string;
  cell: (row: T) => ReactNode;
  num?: boolean;
}

interface Props<T> {
  /** What the data is, for the table caption and the toggle's accessible name. */
  label: string;
  rows: readonly T[];
  columns: ChartTableColumn<T>[];
  rowKey: (row: T, i: number) => string;
  /** The chart. Rendered only in chart view, so a table reader never downloads Recharts work it cannot use. */
  children: ReactNode;
  defaultView?: 'chart' | 'table';
}

/**
 * The same series as a chart or as a table — the keyboard, screen-reader and print twin of every
 * chart panel. The toggle is one control above the plot; the table is the plain `table.data` the rest
 * of the portal uses, so numbers copy out as text.
 */
export function ChartTable<T>({ label, rows, columns, rowKey, children, defaultView = 'chart' }: Props<T>) {
  const [view, setView] = useState<'chart' | 'table'>(defaultView);
  const id = useId();
  return (
    <div className="chart-table">
      <div className="chart-table-bar">
        <div className="seg seg-sm" role="group" aria-label={`View ${label} as`}>
          <button type="button" className={view === 'chart' ? 'active' : ''} aria-pressed={view === 'chart'} onClick={() => setView('chart')}>Chart</button>
          <button type="button" className={view === 'table' ? 'active' : ''} aria-pressed={view === 'table'} onClick={() => setView('table')}>Table</button>
        </div>
      </div>
      {view === 'chart' ? children : (
        <table className="data chart-table-data" aria-describedby={id}>
          <caption id={id} className="sr-only">{label} — the same data as the chart</caption>
          <thead>
            <tr>{columns.map((c) => <th key={c.header} className={c.num ? 'num' : undefined} scope="col">{c.header}</th>)}</tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={rowKey(r, i)}>
                {columns.map((c) => <td key={c.header} className={c.num ? 'num' : undefined}>{c.cell(r)}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
