#!/usr/bin/env bash
# Build the SPA and publish it to the site bucket, then invalidate CloudFront.
# Usage: ./scripts/deploy-frontend.sh <env>
set -euo pipefail

ENV="${1:-dev}"
STACK="Tums-${ENV}-Frontend"
AUTH_STACK="Tums-${ENV}-Auth"
ENV_FILE="frontend/.env.local"

# Pre-flight: Vite bakes frontend/.env.local into the bundle at build time. On 2026-10-26 a fresh
# worktree had no .env.local and the published SPA said "Auth UserPool not configured". Refuse to
# publish a bundle whose Cognito pool is missing or is not the one the Auth stack deployed.
if [[ ! -f "$ENV_FILE" ]]; then
  echo "ERROR: ${ENV_FILE} is missing. It is gitignored — copy it from another worktree or recreate it" >&2
  echo "       from frontend/.env.example using the ${AUTH_STACK} outputs (UserPoolId, ClientId)." >&2
  exit 1
fi
LOCAL_POOL=$(grep -E '^VITE_COGNITO_USER_POOL_ID=' "$ENV_FILE" | tail -1 | cut -d= -f2- | tr -d '"' | tr -d "'" | tr -d '[:space:]')
DEPLOYED_POOL=$(aws cloudformation describe-stacks --stack-name "$AUTH_STACK" \
  --query "Stacks[0].Outputs[?contains(OutputKey, 'UserPoolId')].OutputValue | [0]" --output text)
if [[ -z "$LOCAL_POOL" || "$LOCAL_POOL" == "None" ]]; then
  echo "ERROR: VITE_COGNITO_USER_POOL_ID is not set in ${ENV_FILE}." >&2
  exit 1
fi
if [[ "$LOCAL_POOL" != "$DEPLOYED_POOL" ]]; then
  echo "ERROR: ${ENV_FILE} has VITE_COGNITO_USER_POOL_ID=${LOCAL_POOL} but ${AUTH_STACK} deployed ${DEPLOYED_POOL}." >&2
  echo "       Fix the env file before publishing, or the site cannot sign anyone in." >&2
  exit 1
fi
echo "Pre-flight OK: ${ENV_FILE} matches ${AUTH_STACK} (user pool ${DEPLOYED_POOL})."

echo "Reading stack outputs for ${STACK}…"
BUCKET=$(aws cloudformation describe-stacks --stack-name "$STACK" \
  --query "Stacks[0].Outputs[?OutputKey=='SiteBucketName'].OutputValue" --output text)
DIST_ID=$(aws cloudformation describe-stacks --stack-name "$STACK" \
  --query "Stacks[0].Outputs[?OutputKey=='DistributionId'].OutputValue" --output text)

echo "Building frontend…"
( cd frontend && npm ci && npm run build )

echo "Uploading to s3://${BUCKET}…"
aws s3 sync frontend/dist "s3://${BUCKET}" --delete --exclude "*.map"

echo "Invalidating CloudFront ${DIST_ID}…"
aws cloudfront create-invalidation --distribution-id "$DIST_ID" --paths "/*" >/dev/null

echo "Done. Open the DistributionDomainName from the ${STACK} outputs."
