#!/usr/bin/env bash
# Validate that the agent-cicd-admin Lambda environment variables point to
# the token-monitor system — not to any other system in the same AWS account.
#
# Usage:
#   ./scripts/validate-admin-config.sh                 # uses $AWS_REGION or defaults to us-east-1
#   AWS_REGION=us-east-1 ./scripts/validate-admin-config.sh
#
# Exit codes: 0 = all checks passed, 1 = one or more checks failed
set -euo pipefail

FUNCTION="agent-cicd-admin"
REGION="${AWS_REGION:-us-east-1}"
ERRORS=0

echo "=== Validating ${FUNCTION} (region: ${REGION}) ==="

ENV_JSON=$(aws lambda get-function-configuration \
  --function-name "$FUNCTION" \
  --region "$REGION" \
  --query 'Environment.Variables' \
  --output json 2>&1) || {
  echo "ERROR: Cannot fetch Lambda config — check AWS credentials and region"
  exit 1
}

get_var() { echo "$ENV_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin).get('$1',''))"; }

pass() { echo "  OK   $1"; }
fail() { echo "  FAIL $1"; ERRORS=$((ERRORS+1)); }

# ── 1. TARGET_REPO must point to the token-monitor CI repo ────────────────────
TARGET_REPO=$(get_var TARGET_REPO)
if [[ "$TARGET_REPO" == "timwukp/Claude-code-on-AWS-Bedrock-Token-monitoring-alarm-system" ]]; then
  pass "TARGET_REPO = $TARGET_REPO"
else
  fail "TARGET_REPO: expected 'timwukp/Claude-code-on-AWS-Bedrock-Token-monitoring-alarm-system', got '$TARGET_REPO'"
fi

# ── 2. QA_BUCKET must be the token-monitor reports bucket ─────────────────────
QA_BUCKET=$(get_var QA_BUCKET)
if [[ "$QA_BUCKET" == token-monitor-qa-reports-* ]]; then
  pass "QA_BUCKET = $QA_BUCKET"
else
  fail "QA_BUCKET: expected 'token-monitor-qa-reports-*', got '$QA_BUCKET'"
fi

# ── 3. TARGET_URL must be a CloudFront URL (not a local or llmops endpoint) ───
TARGET_URL=$(get_var TARGET_URL)
if [[ "$TARGET_URL" == https://*.cloudfront.net ]]; then
  pass "TARGET_URL = $TARGET_URL"
else
  fail "TARGET_URL: expected 'https://*.cloudfront.net', got '$TARGET_URL'"
fi

# ── 4. UI_HARNESS must be the UITestAgentHarness (not llmops) ─────────────────
UI_HARNESS=$(get_var UI_HARNESS)
if [[ "$UI_HARNESS" == UITestAgentHarness-* ]]; then
  pass "UI_HARNESS starts with UITestAgentHarness-"
else
  fail "UI_HARNESS: expected 'UITestAgentHarness-*', got '$UI_HARNESS'"
fi

# ── 5. BUGFIX_HARNESS must be the BugFixAgentHarness (not llmops) ─────────────
BUGFIX_HARNESS=$(get_var BUGFIX_HARNESS)
if [[ "$BUGFIX_HARNESS" == BugFixAgentHarness-* ]]; then
  pass "BUGFIX_HARNESS starts with BugFixAgentHarness-"
else
  fail "BUGFIX_HARNESS: expected 'BugFixAgentHarness-*', got '$BUGFIX_HARNESS'"
fi

# ── 6. RUNS_TABLE must be the token-monitor DynamoDB table ────────────────────
RUNS_TABLE=$(get_var RUNS_TABLE)
if [[ "$RUNS_TABLE" == "AgentAdminRuns" ]]; then
  pass "RUNS_TABLE = $RUNS_TABLE"
else
  fail "RUNS_TABLE: expected 'AgentAdminRuns', got '$RUNS_TABLE'"
fi

# ── 7. Cross-system contamination check — no llmops values allowed ────────────
CONTAMINATED=0
for key in TARGET_REPO QA_BUCKET UI_HARNESS BUGFIX_HARNESS RUNS_TABLE; do
  val=$(get_var "$key")
  if echo "$val" | grep -qi "llmops"; then
    fail "CONTAMINATION: $key contains 'llmops' → cross-system pollution detected (val='$val')"
    CONTAMINATED=1
  fi
done
if [[ $CONTAMINATED -eq 0 ]]; then
  pass "No cross-system contamination detected"
fi

# ── Result ────────────────────────────────────────────────────────────────────
echo ""
if [[ $ERRORS -eq 0 ]]; then
  echo "ALL CHECKS PASSED (${FUNCTION})"
  exit 0
else
  echo "${ERRORS} CHECK(S) FAILED — Lambda config may be pointing at the wrong system"
  echo "Run: aws lambda get-function-configuration --function-name ${FUNCTION} --query 'Environment.Variables'"
  exit 1
fi
