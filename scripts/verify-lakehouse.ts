#!/usr/bin/env ts-node
/**
 * verify-lakehouse — dual-run equivalence for the silver layer (owner-run, needs AWS credentials).
 *
 *   cd scripts && npm install && ENV=dev npx ts-node verify-lakehouse.ts
 *
 * The script imports the attribution rules from the backend package (`deriveProject`, `loadAttributionMaps`);
 * Node resolves those files' own dependencies from backend/node_modules, so `cd backend && npm ci` must have run.
 *
 * Checks
 *   1. Attribution: up to 1,000 recent silver.invocations rows, recomputed in TypeScript from the SAME registry
 *      the SQL MERGE (spec/lakehouse/sql/silver_20) reads, must agree with the SQL-written project_id. Disagreements
 *      are listed; "precedence-only" ones (identity vs metadata order — the SQL follows rule C, AIP ▷ identity ▷
 *      metadata; the legacy aggregator keeps metadata ▷ identity) are counted separately.
 *   2. tenant_key cardinality in the window must be < 50 (the 2,524-session-tenant problem, R6).
 *   3. price_status distribution (informational) and the share of rows with model_key present.
 * Exit 1 when agreement (ignoring precedence-only) < 100 % or tenants >= 50.
 */
import { AthenaClient, StartQueryExecutionCommand, GetQueryExecutionCommand, GetQueryResultsCommand } from '@aws-sdk/client-athena';
import { deriveProject, type AttributionMaps, type InvocationRecord } from '../backend/lambdas/ingestion/parse';
import { loadAttributionMaps } from '../backend/lambdas/shared/project-registry';

const ENV = process.env.ENV ?? 'dev';
const REGION = process.env.AWS_REGION ?? 'us-east-1';
const WORKGROUP = process.env.ATHENA_WORKGROUP ?? `token-monitoring-${ENV}`;
const CATALOG = `"s3tablescatalog/tums-lakehouse-${ENV}"`;
const SAMPLE = Number(process.env.SAMPLE ?? 1000);
const WINDOW_DAYS = Number(process.env.WINDOW_DAYS ?? 7);
process.env.TENANTS_TABLE = process.env.TENANTS_TABLE ?? `tums-tenants-${ENV}`;

const athena = new AthenaClient({ region: REGION });

async function query(sql: string): Promise<string[][]> {
  const start = await athena.send(new StartQueryExecutionCommand({ QueryString: sql, WorkGroup: WORKGROUP }));
  const id = start.QueryExecutionId!;
  for (let i = 0; i < 120; i++) {
    const ex = await athena.send(new GetQueryExecutionCommand({ QueryExecutionId: id }));
    const state = ex.QueryExecution?.Status?.State;
    if (state === 'SUCCEEDED') break;
    if (state === 'FAILED' || state === 'CANCELLED') throw new Error(`${state}: ${ex.QueryExecution?.Status?.StateChangeReason}`);
    await new Promise((r) => setTimeout(r, 2000));
  }
  const rows: string[][] = [];
  let token: string | undefined;
  do {
    const res = await athena.send(new GetQueryResultsCommand({ QueryExecutionId: id, NextToken: token, MaxResults: 1000 }));
    for (const r of res.ResultSet?.Rows ?? []) rows.push((r.Data ?? []).map((c) => c.VarCharValue ?? ''));
    token = res.NextToken;
  } while (token);
  return rows.slice(1); // header
}

type Row = { requestId: string; modelIdRaw: string; aipArn: string; tenantKey: string; identityArn: string; projectId: string; attributionSource: string; priceStatus: string; modelKey: string };

function recordFor(r: Row): InvocationRecord {
  // The silver row no longer carries requestMetadata; when the SQL kept a 'metadata' attribution the project is the
  // metadata value, so hand it back to deriveProject through the same field it reads.
  const rec: InvocationRecord = {
    timestamp: '', requestId: r.requestId,
    modelId: r.aipArn || r.modelIdRaw,
    identity: { arn: r.identityArn || r.tenantKey },
    input: { inputTokenCount: 0 }, output: { outputTokenCount: 0 },
  } as unknown as InvocationRecord;
  if (r.attributionSource === 'metadata' && r.projectId) (rec as any).requestMetadata = { project_id: r.projectId };
  return rec;
}

async function main(): Promise<number> {
  const win = `event_day >= cast(date_add('day', -${WINDOW_DAYS}, current_date) as varchar)`;
  console.log(`verify-lakehouse env=${ENV} catalog=${CATALOG} window=${WINDOW_DAYS}d sample=${SAMPLE}`);

  const maps: AttributionMaps = await loadAttributionMaps();
  console.log(`registry: ${maps.profiles.size} profile entries, ${maps.identities.size} identity hints`);

  const rows = (await query(`
    SELECT request_id, model_id_raw, coalesce(aip_arn, ''), tenant_key, coalesce(identity_arn, ''), project_id, attribution_source,
           coalesce(price_status, ''), coalesce(model_key, '')
    FROM ${CATALOG}.silver.invocations
    WHERE ${win}
    ORDER BY event_ts DESC
    LIMIT ${SAMPLE}`)).map((c): Row => ({
    requestId: c[0], modelIdRaw: c[1], aipArn: c[2], tenantKey: c[3], identityArn: c[4], projectId: c[5], attributionSource: c[6], priceStatus: c[7], modelKey: c[8],
  }));

  let agree = 0; let precedenceOnly = 0; const disagreements: string[] = [];
  for (const r of rows) {
    const ts = deriveProject(recordFor(r), maps).projectId;
    if (ts === r.projectId) { agree++; continue; }
    // The two orderings differ only when a row has BOTH a metadata project and an identity hint, and they disagree.
    const identityProject = maps.identities.get((r.identityArn || r.tenantKey).toLowerCase());
    if (r.attributionSource === 'identity' && identityProject === r.projectId && ts !== 'untagged') { precedenceOnly++; continue; }
    disagreements.push(`${r.requestId}: sql=${r.projectId}/${r.attributionSource} ts=${ts} model=${r.modelIdRaw} tenant=${r.tenantKey}`);
  }
  const total = rows.length;
  const pct = total ? ((agree + precedenceOnly) / total) * 100 : 100;

  const tenants = await query(`SELECT count(DISTINCT tenant_key) FROM ${CATALOG}.silver.invocations WHERE ${win}`);
  const tenantCount = Number(tenants[0]?.[0] ?? 0);
  const price = await query(`SELECT coalesce(price_status, '(null)'), count(*) FROM ${CATALOG}.silver.invocations WHERE ${win} GROUP BY 1 ORDER BY 2 DESC`);
  const modelKeyShare = total ? (rows.filter((r) => r.modelKey).length / total) * 100 : 100;

  console.log('\n| check | result | ok |\n|---|---|---|');
  console.log(`| attribution agreement (TS deriveProject vs SQL) | ${agree}/${total} exact, ${precedenceOnly} precedence-only → ${pct.toFixed(2)} % | ${pct >= 100 ? 'PASS' : 'FAIL'} |`);
  console.log(`| distinct tenant_key in window | ${tenantCount} (target < 50) | ${tenantCount < 50 ? 'PASS' : 'FAIL'} |`);
  console.log(`| rows with model_key | ${modelKeyShare.toFixed(1)} % | ${modelKeyShare >= 99.9 ? 'PASS' : 'WARN'} |`);
  console.log(`| price_status distribution | ${price.map((p) => `${p[0]}=${p[1]}`).join(', ')} | info |`);
  if (disagreements.length) { console.log('\nfirst disagreements:'); for (const d of disagreements.slice(0, 10)) console.log('  ' + d); }
  const ok = pct >= 100 && tenantCount < 50;
  console.log(`\nVERIFY ${ok ? 'PASS' : 'FAIL'}`);
  return ok ? 0 : 1;
}

main().then((code) => process.exit(code)).catch((e) => { console.error(e); process.exit(1); });
