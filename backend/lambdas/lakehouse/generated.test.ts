import * as fs from 'fs';
import { buildTables, renderRowTypes, renderTablesJson, ROW_TYPES_TS, SPEC_DIR, TABLES_JSON } from '../../scripts/gen-lakehouse-ddl';

// The spec is the single source of truth. These tests make "edited the spec, forgot to regenerate"
// a red build, and pin the bronze invariants every downstream layer relies on.
describe('lakehouse spec → generated artefacts', () => {
  const tables = buildTables(SPEC_DIR);

  it('committed tables.json equals a fresh render (run `npx ts-node scripts/gen-lakehouse-ddl.ts` after a spec edit)', () => {
    expect(fs.readFileSync(TABLES_JSON, 'utf8')).toBe(renderTablesJson(tables));
  });

  it('committed row-types.ts equals a fresh render', () => {
    expect(fs.readFileSync(ROW_TYPES_TS, 'utf8')).toBe(renderRowTypes(tables));
  });

  it('covers the four bronze tables', () => {
    expect(tables.map((t) => `${t.layer}.${t.table}`)).toEqual([
      'bronze.bedrock_invocations', 'bronze.cur_raw', 'bronze.cw_metrics', 'bronze.otel_spans',
    ]);
  });

  it('every S3 Tables bronze table keeps the producer record verbatim and says where/when it came from', () => {
    for (const t of tables.filter((x) => x.layer === 'bronze' && x.storage === 's3tables')) {
      const req = new Set(t.columns.filter((c) => c.required).map((c) => c.name));
      expect(req.has('raw')).toBe(true);
      expect(req.has('source')).toBe(true);
      expect(req.has('ingest_ts')).toBe(true);
      expect(t.columns.find((c) => c.name === 'raw')!.icebergType).toBe('string');
      expect(t.columns.find((c) => c.name === 'ingest_ts')!.icebergType).toBe('timestamp');
      expect(t.partition).toHaveLength(1);
      expect(t.firehoseRoute).toBeDefined();
    }
  });

  it('bronze is retained forever and flags PII where prompt text can appear', () => {
    for (const t of tables.filter((x) => x.layer === 'bronze')) expect(t.retention).toBe('forever');
    expect(tables.find((t) => t.table === 'bedrock_invocations')!.pii).toBe(true);
    expect(tables.find((t) => t.table === 'otel_spans')!.pii).toBe(true);
    expect(tables.find((t) => t.table === 'cw_metrics')!.pii).toBe(false);
  });

  it('partition columns exist and are strings (Firehose writes the partition value present in the record)', () => {
    for (const t of tables) {
      for (const p of t.partition) {
        const col = t.columns.find((c) => c.name === p.replace(/^[a-z]+\((.*)\)$/, '$1'));
        expect(col).toBeDefined();
        expect(col!.icebergType).toBe('string');
      }
    }
  });
});
