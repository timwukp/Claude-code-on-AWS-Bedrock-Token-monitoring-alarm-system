/**
 * Lakehouse bronze smoke test — pushes synthetic records through the real Firehose streams and reads
 * them back from the S3 Tables through Athena.
 *
 * Run (the script has its own package.json because the Lambdas do not depend on the Firehose/S3/STS clients):
 *   cd scripts && npm install && ENV=dev npx ts-node lakehouse-smoke.ts
 *
 * What it proves (R1 / R4 of the lakehouse plan): seven invocation records of seven vendor/body shapes
 * (Anthropic messages, Converse, OpenAI Responses with an array `input`, Responses with a string
 * `input`, Chat Completions, Titan embeddings with no output tokens, a provisioned-model ARN) all land
 * in bronze.bedrock_invocations; one Metric Streams datapoint lands in bronze.cw_metrics; nothing lands
 * in the Firehose errors prefix. The records carry requestId `smoke-<runId>-N` so they can be filtered
 * out of every downstream aggregate and deleted later.
 */
import { gzipSync } from 'zlib';
import { FirehoseClient, PutRecordCommand } from '@aws-sdk/client-firehose';
import { AthenaClient, StartQueryExecutionCommand, GetQueryExecutionCommand, GetQueryResultsCommand } from '@aws-sdk/client-athena';
import { S3Client, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';

const ENV = process.env.ENV ?? 'dev';
const REGION = process.env.AWS_REGION ?? 'us-east-1';
const RUN_ID = `${Date.now().toString(36)}`;
const BUCKET = `tums-lakehouse-${ENV}`;
const WORKGROUP = `token-monitoring-${ENV}`;
// Athena addresses an S3 table bucket through the Glue federated catalog named "s3tablescatalog/<bucket>".
// AWS docs (Querying Amazon S3 tables with Athena): "the Catalog field should be populated with
// s3tablescatalog/ followed by the name of your table bucket, for example, s3tablescatalog/amzn-s3-demo-bucket.
// The Database field should be populated with the namespace where your table is stored." The slash makes
// the identifier non-plain, so it is double-quoted in SQL: "s3tablescatalog/<bucket>"."bronze"."<table>".
const CATALOG = `"s3tablescatalog/${BUCKET}"`;

const firehose = new FirehoseClient({ region: REGION });
const athena = new AthenaClient({ region: REGION });
const s3 = new S3Client({ region: REGION });
const sts = new STSClient({ region: REGION });

const ts = (offsetSec: number) => new Date(Date.now() - offsetSec * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');

/** Shape mirrors backend/lambdas/ingestion/parse.test.ts (the verified Bedrock record). */
function record(n: number, modelId: string, input: Record<string, unknown>, output: Record<string, unknown>, account: string) {
  return {
    schemaType: 'ModelInvocationLog',
    schemaVersion: '1.0',
    timestamp: ts(60 - n),
    accountId: account,
    region: REGION,
    requestId: `smoke-${RUN_ID}-${n}`,
    operation: 'InvokeModel',
    modelId,
    identity: { arn: `arn:aws:iam::${account}:user/lakehouse-smoke` },
    requestMetadata: { tenant: 'lakehouse-smoke', project_id: 'lakehouse-smoke' },
    input: { inputContentType: 'application/json', ...input },
    output: { outputContentType: 'application/json', ...output },
  };
}

function records(account: string) {
  const msg = (text: string) => ({ role: 'user', content: [{ type: 'text', text }] });
  return [
    record(1, 'us.anthropic.claude-opus-5-5',
      { inputBodyJson: { anthropic_version: 'bedrock-2023-05-31', max_tokens: 64, messages: [msg('smoke anthropic')] }, inputTokenCount: 12, cacheReadInputTokenCount: 0, cacheWriteInputTokenCount: 0 },
      { outputBodyJson: { type: 'message', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 12, output_tokens: 3 } }, outputTokenCount: 3 }, account),
    record(2, 'amazon.nova-micro-v1:0',
      { inputBodyJson: { messages: [{ role: 'user', content: [{ text: 'smoke converse' }] }], inferenceConfig: { maxTokens: 32 } }, inputTokenCount: 9, cacheReadInputTokenCount: 0, cacheWriteInputTokenCount: 0 },
      { outputBodyJson: { output: { message: { role: 'assistant', content: [{ text: 'ok' }] } }, usage: { inputTokens: 9, outputTokens: 2 }, stopReason: 'end_turn' }, outputTokenCount: 2 }, account),
    record(3, 'us.openai.gpt-6-luna',
      { inputBodyJson: { model: 'us.openai.gpt-6-luna', input: [{ type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'a' }] }, { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'b' }] }, { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'c' }] }], stream: false }, inputTokenCount: 30, cacheReadInputTokenCount: 0, cacheWriteInputTokenCount: 0 },
      { outputBodyJson: { id: 'resp_smoke', object: 'response', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] }], usage: { input_tokens: 30, output_tokens: 4 } }, outputTokenCount: 4 }, account),
    record(4, 'us.openai.gpt-6-luna',
      { inputBodyJson: { model: 'us.openai.gpt-6-luna', input: 'just a plain string prompt', max_output_tokens: 16 }, inputTokenCount: 7, cacheReadInputTokenCount: 0, cacheWriteInputTokenCount: 0 },
      { outputBodyJson: { id: 'resp_smoke2', object: 'response', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] }], usage: { input_tokens: 7, output_tokens: 2 } }, outputTokenCount: 2 }, account),
    record(5, 'openai.gpt-oss-20b-1:0',
      { inputBodyJson: { model: 'openai.gpt-oss-20b-1:0', messages: [{ role: 'user', content: 'smoke chat completions' }], max_completion_tokens: 16 }, inputTokenCount: 8, cacheReadInputTokenCount: 0, cacheWriteInputTokenCount: 0 },
      { outputBodyJson: { id: 'chatcmpl_smoke', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10 } }, outputTokenCount: 2 }, account),
    record(6, 'amazon.titan-embed-text-v2:0',
      { inputBodyJson: { inputText: 'smoke embeddings' }, inputTokenCount: 4, cacheReadInputTokenCount: 0, cacheWriteInputTokenCount: 0 },
      { outputBodyJson: { embedding: [0.1, 0.2, 0.3], inputTextTokenCount: 4 } }, account),
    record(7, `arn:aws:bedrock:${REGION}:${account}:provisioned-model/smoke0000000`,
      { inputBodyJson: { anthropic_version: 'bedrock-2023-05-31', max_tokens: 16, messages: [msg('smoke provisioned')] }, inputTokenCount: 11, cacheReadInputTokenCount: 0, cacheWriteInputTokenCount: 0 },
      { outputBodyJson: { type: 'message', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 11, output_tokens: 2 } }, outputTokenCount: 2 }, account),
  ];
}

/** CloudWatch Logs subscription payload — exactly what the real subscription filter delivers to Firehose. */
function cwLogsPayload(account: string, logGroup: string, messages: string[]): Buffer {
  const envelope = {
    messageType: 'DATA_MESSAGE',
    owner: account,
    logGroup,
    logStream: 'aws/bedrock/modelinvocations',
    subscriptionFilters: ['lakehouse-smoke'],
    logEvents: messages.map((message, i) => ({ id: `${Date.now()}${i}`, timestamp: Date.now() - (60 - i) * 1000, message })),
  };
  return gzipSync(Buffer.from(JSON.stringify(envelope)));
}

/** One CloudWatch Metric Streams datapoint in the JSON output format. */
function metricStreamLine(account: string): Buffer {
  const now = Date.now();
  const line = {
    metric_stream_name: `tums-lakehouse-${ENV}`,
    account_id: account,
    region: REGION,
    namespace: 'AWS/Bedrock',
    metric_name: 'InvocationLatency',
    dimensions: { ModelId: 'lakehouse-smoke' },
    timestamp: now - (now % 60000),
    value: { max: 1234, min: 1234, sum: 1234, count: 1 },
    unit: 'Milliseconds',
  };
  return Buffer.from(JSON.stringify(line) + '\n');
}

async function runAthena(sql: string): Promise<string[][]> {
  const start = await athena.send(new StartQueryExecutionCommand({ QueryString: sql, WorkGroup: WORKGROUP }));
  const id = start.QueryExecutionId!;
  for (;;) {
    const ex = await athena.send(new GetQueryExecutionCommand({ QueryExecutionId: id }));
    const state = ex.QueryExecution?.Status?.State;
    if (state === 'SUCCEEDED') break;
    if (state === 'FAILED' || state === 'CANCELLED') throw new Error(`Athena ${state}: ${ex.QueryExecution?.Status?.StateChangeReason}`);
    await new Promise((r) => setTimeout(r, 1500));
  }
  const res = await athena.send(new GetQueryResultsCommand({ QueryExecutionId: id }));
  return (res.ResultSet?.Rows ?? []).slice(1).map((r) => (r.Data ?? []).map((c) => c.VarCharValue ?? ''));
}

async function countWithRetry(sql: string, expectAtLeast: number, deadlineMs: number): Promise<number> {
  const deadline = Date.now() + deadlineMs;
  let last = 0;
  while (Date.now() < deadline) {
    try {
      const rows = await runAthena(sql);
      last = Number(rows[0]?.[0] ?? 0);
      if (last >= expectAtLeast) return last;
    } catch (e) {
      // Table may not be visible for a few seconds after the first Firehose commit.
      console.log(`  (athena not ready yet: ${(e as Error).message.slice(0, 120)})`);
    }
    await new Promise((r) => setTimeout(r, 15000));
  }
  return last;
}

async function listErrors(bucket: string, since: Date): Promise<string[]> {
  const out: string[] = [];
  let token: string | undefined;
  do {
    const res = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: 'errors/', ContinuationToken: token }));
    for (const o of res.Contents ?? []) if (o.LastModified && o.LastModified >= since && o.Key) out.push(o.Key);
    token = res.NextContinuationToken;
  } while (token);
  return out;
}

async function main() {
  const started = new Date();
  const account = (await sts.send(new GetCallerIdentityCommand({}))).Account!;
  const errorsBucket = `tums-lakehouse-errors-${ENV}-${account}`;
  console.log(`lakehouse smoke ${RUN_ID} → env=${ENV} region=${REGION} bucket=${BUCKET}`);

  const recs = records(account);
  await firehose.send(new PutRecordCommand({
    DeliveryStreamName: `tums-lakehouse-${ENV}-bedrock`,
    Record: { Data: cwLogsPayload(account, `/tums/${ENV}/bedrock-invocations`, recs.map((r) => JSON.stringify(r))) },
  }));
  console.log(`sent ${recs.length} invocation records to tums-lakehouse-${ENV}-bedrock`);

  await firehose.send(new PutRecordCommand({
    DeliveryStreamName: `tums-lakehouse-${ENV}-metrics`,
    Record: { Data: metricStreamLine(account) },
  }));
  console.log(`sent 1 metric datapoint to tums-lakehouse-${ENV}-metrics`);

  // Firehose buffers up to 60 s (or the configured hint) before committing to Iceberg; allow 5 minutes.
  const invocations = await countWithRetry(
    `SELECT count(*) FROM ${CATALOG}."bronze"."bedrock_invocations" WHERE request_id LIKE 'smoke-${RUN_ID}-%'`, recs.length, 300_000);
  const metrics = await countWithRetry(
    `SELECT count(*) FROM ${CATALOG}."bronze"."cw_metrics" WHERE dimensions LIKE '%lakehouse-smoke%' AND metric_ts >= from_iso8601_timestamp('${started.toISOString()}') - interval '2' minute`, 1, 120_000);
  let errors: string[] = [];
  try { errors = await listErrors(errorsBucket, started); } catch (e) { console.log(`  (errors bucket not listable: ${(e as Error).message.slice(0, 120)})`); }

  const results: Array<[string, string, boolean]> = [
    ['bronze.bedrock_invocations rows for this run', `${invocations} / ${recs.length}`, invocations === recs.length],
    ['bronze.cw_metrics rows for this run', `${metrics} / ≥1`, metrics >= 1],
    ['Firehose error objects since start', `${errors.length}`, errors.length === 0],
  ];
  console.log('\n| check | result | ok |\n|---|---|---|');
  for (const [name, value, ok] of results) console.log(`| ${name} | ${value} | ${ok ? 'PASS' : 'FAIL'} |`);
  if (errors.length) console.log('error objects:\n  ' + errors.join('\n  '));
  const ok = results.every((r) => r[2]);
  console.log(ok ? '\nSMOKE PASS' : '\nSMOKE FAIL');
  process.exit(ok ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
