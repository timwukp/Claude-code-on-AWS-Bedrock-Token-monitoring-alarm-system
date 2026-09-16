/**
 * One-off local runner for the DORA collector (manual backfill / verification).
 * Uses the same handler the scheduled Lambda would, against the real DynamoDB table and the
 * GitHub token in Secrets Manager, driven by the caller's local AWS credentials. Idempotent:
 * PRs are keyed by (mergedAt, number) and unchanged ones are skipped, so re-running is safe.
 *
 * Usage (see the Data / Dora stack outputs for names):
 *   DORA_TABLE=tums-dora-dev \
 *   GITHUB_TOKEN_SECRET_NAME=token-monitor-demo/github-token \
 *   DORA_SEED_REPOS=owner/a,owner/b \
 *   AWS_REGION=us-east-1 \
 *   [REPO=owner/name] \
 *   npx ts-node scripts/run-dora-collector-once.ts
 */
import { handler } from '../lambdas/dora/collector';

(async () => {
  const res = await handler(process.env.REPO ? { repo: process.env.REPO } : {});
  console.log('Collector result:', JSON.stringify(res, null, 2));
})().catch((err) => {
  console.error('Collector run failed:', err);
  process.exit(1);
});
