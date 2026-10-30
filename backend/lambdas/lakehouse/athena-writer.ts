/**
 * Minimal synchronous Athena runner for the small silver maintenance Lambdas (dim_model refresh,
 * registry snapshot). Statements are built by the callers from VALUES literals; every string is
 * quoted through `sqlString`, which doubles quotes and strips control characters, so nothing a
 * model id or project name contains can break out of its literal.
 */
import { AthenaClient, GetQueryExecutionCommand, StartQueryExecutionCommand } from '@aws-sdk/client-athena';

export interface AthenaTarget { workgroup: string; outputLocation?: string; catalogTable: (table: string) => string }

/** `"s3tablescatalog/<bucket>".silver.<table>` — how Athena addresses an S3 Tables table. */
export function silverTableRef(tableBucket: string, table: string): string {
  return `"s3tablescatalog/${tableBucket}"."silver"."${table}"`;
}

export function sqlString(v: unknown): string {
  if (v === null || v === undefined) return 'NULL';
  const s = String(v).replace(/[\u0000-\u001f\u007f]/g, '');
  return `'${s.replace(/'/g, "''")}'`;
}

export function sqlTimestamp(iso: string): string {
  return `TIMESTAMP ${sqlString(iso.replace('T', ' ').replace('Z', ''))}`;
}

export function sqlNumber(v: unknown): string {
  return typeof v === 'number' && Number.isFinite(v) ? String(v) : 'NULL';
}

export function sqlBool(v: unknown): string {
  return v === true ? 'true' : v === false ? 'false' : 'NULL';
}

/** INSERT INTO <ref> (cols) VALUES (...), (...) in chunks small enough for Athena's 256 KB statement limit. */
export function insertStatements(ref: string, columns: string[], rows: string[][], maxRowsPerStatement = 200): string[] {
  const out: string[] = [];
  for (let i = 0; i < rows.length; i += maxRowsPerStatement) {
    const values = rows.slice(i, i + maxRowsPerStatement).map((r) => `(${r.join(', ')})`).join(',\n');
    out.push(`INSERT INTO ${ref} (${columns.join(', ')})\nVALUES\n${values}`);
  }
  return out;
}

export class AthenaRunner {
  constructor(private client: AthenaClient, private workgroup: string, private outputLocation?: string) {}

  async run(sql: string, timeoutMs = 240_000): Promise<string> {
    const start = await this.client.send(new StartQueryExecutionCommand({
      QueryString: sql, WorkGroup: this.workgroup,
      ...(this.outputLocation ? { ResultConfiguration: { OutputLocation: this.outputLocation } } : {}),
    }));
    const id = start.QueryExecutionId!;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const ex = await this.client.send(new GetQueryExecutionCommand({ QueryExecutionId: id }));
      const state = ex.QueryExecution?.Status?.State;
      if (state === 'SUCCEEDED') return id;
      if (state === 'FAILED' || state === 'CANCELLED') throw new Error(`Athena ${state}: ${ex.QueryExecution?.Status?.StateChangeReason ?? ''} — ${sql.slice(0, 200)}`);
      if (Date.now() > deadline) throw new Error(`Athena query ${id} still ${state} after ${timeoutMs} ms`);
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
}
