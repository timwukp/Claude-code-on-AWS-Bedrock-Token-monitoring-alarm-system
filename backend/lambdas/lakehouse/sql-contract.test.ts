import * as fs from 'fs';
import * as path from 'path';
import { buildTables, SPEC_DIR } from '../../scripts/gen-lakehouse-ddl';

/**
 * Silver/gold SQL lives in spec/lakehouse/sql/*.sql (written by the SQL chain). CI has no Athena, so the
 * contract is structural: every `t_<table>.<column>` reference must name a column the spec defines for
 * that table. Convention: table aliases are `t_<table>` (e.g. `FROM silver.invocations t_invocations`).
 */
const SQL_DIR = path.join(SPEC_DIR, 'sql');

describe('spec/lakehouse/sql contract', () => {
  const tables = buildTables(SPEC_DIR);
  const columnsByTable = new Map(tables.map((t) => [t.table, new Set(t.columns.map((c) => c.name))]));
  const files = fs.existsSync(SQL_DIR) ? fs.readdirSync(SQL_DIR).filter((f) => f.endsWith('.sql')).sort() : [];

  it('the SQL directory exists', () => {
    expect(fs.existsSync(SQL_DIR)).toBe(true);
  });

  it.each(files.length ? files : ['(no sql files yet)'])('%s references only spec columns through t_<table>.<column>', (file) => {
    if (file === '(no sql files yet)') return;
    const sql = fs.readFileSync(path.join(SQL_DIR, file), 'utf8').replace(/--[^\n]*/g, '');
    const refs = [...sql.matchAll(/\bt_([a-z][a-z0-9_]*)\.([a-z][a-z0-9_]*)\b/g)];
    // a file with no aliased column reference must be a catalog-level check (information_schema) to be exempt
    if (refs.length === 0) { expect(sql).toMatch(/information_schema/i); return; }
    const bad = refs.map((m) => `${m[1]}.${m[2]}`).filter((r) => { const [t, c] = r.split('.'); const cols = columnsByTable.get(t); return !cols || !cols.has(c); });
    expect([...new Set(bad)]).toEqual([]);
  });
});
