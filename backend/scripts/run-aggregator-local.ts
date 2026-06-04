/**
 * Local runner: executes the real aggregator handler against the deployed AWS resources,
 * using your local AWS credentials. This is how the pipeline was validated end-to-end without
 * deploying the scheduled Lambda. Usage:
 *   AGGREGATES_TABLE=... RAW_LOG_BUCKET=... npx ts-node scripts/run-aggregator-local.ts
 */
import { handler } from '../lambdas/ingestion/aggregator';

(async () => {
  const result = await handler();
  console.log('Aggregator result:', JSON.stringify(result));
})().catch((e) => {
  console.error('Aggregator failed:', e);
  process.exit(1);
});
