#!/usr/bin/env bash
# Build the SPA and publish it to the site bucket, then invalidate CloudFront.
# Usage: ./scripts/deploy-frontend.sh <env>
set -euo pipefail

ENV="${1:-dev}"
STACK="Tums-${ENV}-Frontend"

echo "Reading stack outputs for ${STACK}…"
BUCKET=$(aws cloudformation describe-stacks --stack-name "$STACK" \
  --query "Stacks[0].Outputs[?OutputKey=='SiteBucketName'].OutputValue" --output text)
DIST_ID=$(aws cloudformation describe-stacks --stack-name "$STACK" \
  --query "Stacks[0].Outputs[?OutputKey=='DistributionId'].OutputValue" --output text)

echo "Building frontend…"
( cd frontend && npm ci && npm run build )

echo "Uploading to s3://${BUCKET}…"
aws s3 sync frontend/dist "s3://${BUCKET}" --delete

echo "Invalidating CloudFront ${DIST_ID}…"
aws cloudfront create-invalidation --distribution-id "$DIST_ID" --paths "/*" >/dev/null

echo "Done. Open the DistributionDomainName from the ${STACK} outputs."
