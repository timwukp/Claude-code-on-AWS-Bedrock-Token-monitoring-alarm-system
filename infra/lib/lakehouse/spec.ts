import * as fs from 'fs';
import * as path from 'path';

/**
 * Reads spec/lakehouse/*.schema.json — the single source of truth for every lakehouse table — and
 * turns it into the column lists the CDK stack needs. The same files drive the transform Lambda's
 * row types (backend/scripts/gen-lakehouse-ddl.ts), so a spec edit reaches both sides or neither.
 */
export const SPEC_DIR = path.join(__dirname, '..', '..', '..', 'spec', 'lakehouse');

export interface LakehouseSpec {
  readonly title: string;
  readonly properties: Record<string, { type?: string; format?: string; description?: string }>;
  readonly required: string[];
  readonly lakehouse: {
    readonly layer: string;
    readonly table: string;
    readonly storage: 's3tables' | 'glue-external';
    readonly partition: string[];
    readonly retention: string;
    readonly pii: boolean;
    readonly firehoseRoute?: { stream: string; match: string };
  };
}

export function loadLakehouseSpecs(dir: string = SPEC_DIR): LakehouseSpec[] {
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.schema.json'))
    .sort()
    .map((f) => {
      const doc = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      return { title: doc.title, properties: doc.properties, required: doc.required ?? [], lakehouse: doc['x-lakehouse'] };
    });
}

/** JSON Schema scalar → Iceberg primitive. Unknown types fail loudly: a silent `string` would hide a spec mistake. */
export function icebergType(prop: { type?: string; format?: string }): string {
  if (prop.type === 'string' && prop.format === 'date-time') return 'timestamp';
  switch (prop.type) {
    case 'string': return 'string';
    case 'integer': return 'long';
    case 'number': return 'double';
    case 'boolean': return 'boolean';
    default: throw new Error(`lakehouse spec: unsupported JSON Schema type ${JSON.stringify(prop)}`);
  }
}

/** Glue/Athena column type for a Parquet external table (CUR). */
export function glueType(prop: { type?: string; format?: string }): string {
  const t = icebergType(prop);
  return t === 'long' ? 'bigint' : t;
}

export interface IcebergField { name: string; type: string; required: boolean }

export function icebergFields(spec: LakehouseSpec): IcebergField[] {
  return Object.entries(spec.properties).map(([name, prop]) => ({
    name, type: icebergType(prop), required: spec.required.includes(name),
  }));
}
