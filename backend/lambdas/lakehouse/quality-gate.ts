import { AthenaClient, GetQueryResultsCommand } from '@aws-sdk/client-athena';

/**
 * Step Functions quality gate: a `quality_*.sql` statement returns the offending rows, so an empty
 * result set is a pass and any data row fails the state machine (which alarms). Pure decision in
 * `evaluateQualityRows`; the handler only fetches the first page.
 */
export interface QualityGateEvent { queryExecutionId: string; check: string }

export function evaluateQualityRows(rows: Array<{ Data?: Array<{ VarCharValue?: string }> }>, check: string): { pass: boolean; offending: number; sample: string[] } {
  const data = rows.slice(1); // row 0 is the header
  const sample = data.slice(0, 5).map((r) => (r.Data ?? []).map((c) => c.VarCharValue ?? '').join(' | '));
  return { pass: data.length === 0, offending: data.length, sample: sample.map((s) => `${check}: ${s}`) };
}

const athena = new AthenaClient({});

export const handler = async (event: QualityGateEvent) => {
  const res = await athena.send(new GetQueryResultsCommand({ QueryExecutionId: event.queryExecutionId, MaxResults: 21 }));
  const verdict = evaluateQualityRows(res.ResultSet?.Rows ?? [], event.check);
  if (!verdict.pass) {
    throw new Error(`quality gate ${event.check} failed: ${verdict.offending} offending row(s); first: ${verdict.sample.join(' ;; ')}`);
  }
  return { check: event.check, pass: true };
};
