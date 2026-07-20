/**
 * One-off local runner for the ingestion aggregator (manual backfill / verification).
 * Uses the same handler the scheduled Lambda would, with the real DynamoDB table and S3 bucket,
 * driven by the caller's local AWS credentials. Idempotent: the handler de-dups by requestId and
 * advances the watermark, so re-running is safe.
 *
 * Usage (fill in your own table/bucket names — see the Data stack outputs):
 *   AGGREGATES_TABLE=<aggregates-table> \
 *   RAW_LOG_BUCKET=<raw-log-bucket> \
 *   AWS_REGION=<region> \
 *   npx ts-node scripts/run-aggregator-once.ts
 */
import { handler } from '../lambdas/ingestion/aggregator';

(async () => {
  const res = await handler();
  console.log('Aggregator result:', JSON.stringify(res));
})().catch((err) => {
  console.error('Aggregator run failed:', err);
  process.exit(1);
});
