#!/usr/bin/env bash
# Read-only check after `cdk deploy Tums-<env>-QaBroker` (feature-53). Deploying is CDK's job; this only reads.
#
#   ./scripts/verify-qa-broker.sh [env]          # env defaults to dev; the pool is tums-<env>
#
# 1. IAM simulation: the broker role and the CI role each get exactly the decisions below (a 200 is not success).
# 2. The function is Active and its last update succeeded.
# 3. A probe with a runId that holds no lease must answer {"ok": false, "error": "no-lease"}: the broker checks the
#    lease first, so this probe writes nothing and signs nobody in.
# Prints no account ID, no ARN and no password. Exits non-zero on the first unexpected answer.
set -euo pipefail

ENV_NAME="${1:-dev}"
REGION="${AWS_REGION:-us-east-1}"
FN=qa-login-reset                       # infra/lib/stacks/qa-broker-stack.ts: QA_BROKER_FUNCTION
BROKER_ROLE=qa-login-reset-role         # ... QA_BROKER_ROLE
CI_ROLE=GitHubActionsUITestRole         # ... qaBroker.ciRoleName in the env file
LOCK_KEY=locks/ui-harness.json          # ci-agent/harness_lock_spec.json: key
VIEWER_SECRET=token-monitor-demo/login-creds-viewer
ADMIN_SECRET=token-monitor-demo/login-creds

ACCT=$(aws sts get-caller-identity --query Account --output text)
BUCKET="token-monitor-qa-reports-$ACCT"
POOL=$(aws cognito-idp list-user-pools --max-results 50 --region "$REGION" \
  --query "UserPools[?Name=='tums-$ENV_NAME'].Id" --output text)
[ -n "$POOL" ] || { echo "no user pool named tums-$ENV_NAME" >&2; exit 1; }
POOL_ARN="arn:aws:cognito-idp:$REGION:$ACCT:userpool/$POOL"
V_ARN=$(aws secretsmanager describe-secret --secret-id "$VIEWER_SECRET" --region "$REGION" --query ARN --output text)
A_ARN=$(aws secretsmanager describe-secret --secret-id "$ADMIN_SECRET" --region "$REGION" --query ARN --output text)
FN_ARN="arn:aws:lambda:$REGION:$ACCT:function:$FN"
OUT=$(mktemp "${TMPDIR:-/tmp}/verify-qa-broker.XXXXXX")
trap 'rm -f "$OUT"' EXIT

fails=0
simulate() {  # role action resource expected
  local got
  got=$(aws iam simulate-principal-policy --policy-source-arn "arn:aws:iam::$ACCT:role/$1" --action-names "$2" \
        --resource-arns "$3" --query 'EvaluationResults[0].EvalDecision' --output text)
  printf '  %-24s %-42s %-13s %s\n' "$1" "$2" "$got" "$([ "$got" = "$4" ] && echo ok || echo "EXPECTED $4")"
  [ "$got" = "$4" ] || fails=$((fails + 1))
}

echo "IAM (simulated against each role's attached policies):"
simulate "$BROKER_ROLE" cognito-idp:AdminSetUserPassword "$POOL_ARN" allowed
simulate "$BROKER_ROLE" cognito-idp:AdminUserGlobalSignOut "$POOL_ARN" allowed
simulate "$BROKER_ROLE" cognito-idp:AdminDeleteUser "$POOL_ARN" implicitDeny
simulate "$BROKER_ROLE" secretsmanager:PutSecretValue "$V_ARN" allowed
simulate "$BROKER_ROLE" secretsmanager:UpdateSecretVersionStage "$A_ARN" allowed
simulate "$BROKER_ROLE" s3:GetObject "arn:aws:s3:::$BUCKET/$LOCK_KEY" allowed
simulate "$BROKER_ROLE" s3:PutObject "arn:aws:s3:::$BUCKET/$LOCK_KEY" implicitDeny
simulate "$CI_ROLE" lambda:InvokeFunction "$FN_ARN" allowed
simulate "$CI_ROLE" cognito-idp:AdminSetUserPassword "$POOL_ARN" implicitDeny
simulate "$CI_ROLE" secretsmanager:PutSecretValue "$V_ARN" implicitDeny

STATE=$(aws lambda get-function-configuration --function-name "$FN" --region "$REGION" \
  --query '[State,LastUpdateStatus,Runtime,Handler]' --output text)
echo "function: $STATE"
[ "$STATE" = "$(printf 'Active\tSuccessful\tpython3.12\tqa_reset_broker.lambda_handler')" ] || fails=$((fails + 1))

aws lambda invoke --function-name "$FN" --region "$REGION" --cli-binary-format raw-in-base64-out \
  --payload '{"action":"rotate","secret":"viewer","runId":"verify-probe-no-lease","signOut":false}' "$OUT" >/dev/null
echo "probe (a runId that holds no lease): $(cat "$OUT")"
python3 -c 'import json,sys; r=json.load(open(sys.argv[1])); sys.exit(0 if r == {"ok": False, "error": "no-lease"} else 1)' "$OUT" \
  || { echo "  EXPECTED {\"ok\": false, \"error\": \"no-lease\"} (a lease held now gives lease-not-yours: re-run when the harness is free)"; fails=$((fails + 1)); }

[ "$fails" -eq 0 ] && echo "verify-qa-broker: all checks passed" || { echo "verify-qa-broker: $fails check(s) failed" >&2; exit 1; }
