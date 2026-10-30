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

  it('covers the four bronze and six silver tables', () => {
    expect(tables.map((t) => `${t.layer}.${t.table}`)).toEqual([
      'bronze.bedrock_invocations', 'bronze.cur_raw', 'bronze.cw_metrics', 'bronze.otel_spans',
      'silver.adapter_audit', 'silver.bedrock_metrics_hourly', 'silver.bill_daily', 'silver.dim_model', 'silver.invocations', 'silver.project_registry',
    ]);
  });

  it('every silver table says when it was written, and silver.invocations carries no body or raw payload', () => {
    for (const t of tables.filter((x) => x.layer === 'silver')) {
      const names = new Set(t.columns.map((c) => c.name));
      expect(names.has('ingest_ts') || names.has('refreshed_at') || names.has('snapshot_ts') || names.has('event_ts') || names.has('hour_ts')).toBe(true);
      expect(t.storage).toBe('s3tables');
    }
    const inv = tables.find((t) => t.layer === 'silver' && t.table === 'invocations')!;
    const names = inv.columns.map((c) => c.name);
    for (const forbidden of ['raw', 'input_body_json', 'output_body_json', 'messages', 'prompt']) expect(names).not.toContain(forbidden);
    expect(names).toContain('body_s3_path'); // the pointer is allowed; the body is not
    for (const req of ['request_id', 'model_key', 'vendor', 'tenant_key', 'project_id', 'attribution_source', 'input_tokens', 'output_tokens', 'token_source']) {
      expect(inv.columns.find((c) => c.name === req)!.required).toBe(true);
    }
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
