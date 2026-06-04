#!/usr/bin/env bash
# NOTE: As of the AutomationStack, the Cost Anomaly Detection monitor + subscription are created
# automatically by CDK (AWS::CE::AnomalyMonitor / AWS::CE::AnomalySubscription). This script is
# kept for reference / manual setup outside the CDK app.
#
# Create the Cost Anomaly Detection monitor + IMMEDIATE (SNS) subscription.
# Done via CLI because `ce` has limited CloudFormation coverage. Verified against:
#   https://docs.aws.amazon.com/cli/latest/reference/ce/create-anomaly-monitor.html
#   https://docs.aws.amazon.com/cli/latest/reference/ce/create-anomaly-subscription.html
# Usage: ./scripts/setup-cost-anomaly.sh <sns-topic-arn> <impact-usd>
set -euo pipefail

TOPIC_ARN="${1:?Pass the SNS alert topic ARN}"
IMPACT_USD="${2:-10}"

MONITOR_ARN=$(aws ce create-anomaly-monitor \
  --anomaly-monitor '{
    "MonitorName": "bedrock-spend-anomaly",
    "MonitorType": "DIMENSIONAL",
    "MonitorDimension": "SERVICE"
  }' --query MonitorArn --output text)

echo "Created monitor: ${MONITOR_ARN}"

aws ce create-anomaly-subscription \
  --anomaly-subscription "{
    \"SubscriptionName\": \"bedrock-alerts\",
    \"MonitorArnList\": [\"${MONITOR_ARN}\"],
    \"Subscribers\": [{\"Address\": \"${TOPIC_ARN}\", \"Type\": \"SNS\"}],
    \"Frequency\": \"IMMEDIATE\",
    \"ThresholdExpression\": {
      \"Dimensions\": {
        \"Key\": \"ANOMALY_TOTAL_IMPACT_ABSOLUTE\",
        \"MatchOptions\": [\"GREATER_THAN_OR_EQUAL\"],
        \"Values\": [\"${IMPACT_USD}\"]
      }
    }
  }"

echo "Subscription created (IMMEDIATE → SNS)."
