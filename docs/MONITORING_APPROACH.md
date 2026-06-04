# Monitoring Approach (source-verified)

The platform combines five AWS-native mechanisms on top of CloudWatch alarms. Every factual
claim below — metric names, log schema, API parameters, prices — is verified against the
official AWS / Anthropic documentation linked in **Sources**. Replace example values
(`<account-id>`, `<bucket>`, regions) with your own; nothing here is customer-specific.

---

## Current baseline: CloudWatch metrics + alarms

- Bedrock emits `InputTokenCount`, `OutputTokenCount`, and `Invocations` under the
  `AWS/Bedrock` namespace (related: `InvocationLatency`, `InvocationThrottles`,
  `InvocationClientErrors`, `InvocationServerErrors`).
- CloudWatch Alarms trigger SNS when thresholds are breached.
- Limitation: static thresholds that don't adapt to usage patterns.

---

## 1. AWS Cost Anomaly Detection (ML)

| Aspect | Detail |
|---|---|
| Mechanism | ML anomaly detection on **spend** (cost) patterns — not raw token metrics |
| Setup | Low-config: one cost monitor + ≥1 alert subscription. Baseline is auto-learned; a subscription threshold is still required |
| Granularity | Monitor dimension is one of: AWS services, linked account, cost allocation tag, cost category. **Not per-IAM-identity** |
| Alert | Email, or SNS (`IMMEDIATE`); daily/weekly email summaries |
| Cost | Free feature (you still pay for monitored resources) |

```bash
aws ce create-anomaly-monitor \
  --anomaly-monitor '{
    "MonitorName": "bedrock-spend-anomaly",
    "MonitorType": "DIMENSIONAL",
    "MonitorDimension": "SERVICE"
  }'

aws ce create-anomaly-subscription \
  --anomaly-subscription '{
    "SubscriptionName": "bedrock-alerts",
    "MonitorArnList": ["arn:aws:ce::<account-id>:anomalymonitor/<MONITOR_ID>"],
    "Subscribers": [
      {"Address": "arn:aws:sns:<region>:<account-id>:bedrock-security-alerts", "Type": "SNS"}
    ],
    "Frequency": "IMMEDIATE",
    "ThresholdExpression": {
      "Dimensions": {
        "Key": "ANOMALY_TOTAL_IMPACT_ABSOLUTE",
        "MatchOptions": ["GREATER_THAN_OR_EQUAL"],
        "Values": ["10"]
      }
    }
  }'
```

> `IMMEDIATE` requires an **SNS** subscriber; `DAILY`/`WEEKLY` require **EMAIL**. The legacy
> flat `Threshold` field is deprecated — use `ThresholdExpression`
> (`ANOMALY_TOTAL_IMPACT_ABSOLUTE` for dollars, `ANOMALY_TOTAL_IMPACT_PERCENTAGE` for percent).

---

## 2. Model Invocation Logging → S3 → Athena (forensics)

| Aspect | Detail |
|---|---|
| Mechanism | Bedrock logs each invocation's metadata + input/output bodies to S3 and/or CloudWatch Logs |
| Log fields | `timestamp`, `accountId`, `region`, `requestId`, `operation`, `modelId`, `input.inputTokenCount`, `output.outputTokenCount`, optional `requestMetadata`. **No IAM caller identity in the record** — attribute via `requestMetadata` tags or correlate `requestId` with CloudTrail |
| Query | Athena SQL over JSON in S3 (gzipped; bodies > 100 KB stored as separate S3 objects) |
| Cost | S3 storage + $5.00 per TB scanned by Athena |

```bash
aws bedrock put-model-invocation-logging-configuration \
  --logging-config '{
    "s3Config": { "bucketName": "<bucket>", "keyPrefix": "model-logs/" }
  }' --region <region>
```

**Athena table** (newline-delimited JSON → OpenX JSON SerDe). The schema below was
**verified against real delivered logs** in account 123456789012 (us-east-1), not just the
docs — see `docs/VERIFICATION.md`. Two findings differ from the published userguide example:
the record **does** contain an `identity.arn` (the caller IAM ARN), and it carries prompt-cache
token counts plus an `inputBodyS3Path` reference when the input body exceeds 100 KB.

Real S3 layout (confirmed):
`s3://<bucket>/model-logs/AWSLogs/<account-id>/BedrockModelInvocationLogs/<region>/YYYY/MM/DD/HH/`

```sql
CREATE EXTERNAL TABLE bedrock_invocation_logs (
  schemaType      string,
  schemaVersion   string,
  `timestamp`     string,
  accountId       string,
  region          string,
  requestId       string,
  operation       string,
  modelId         string,
  inferenceRegion string,
  identity        struct<arn:string>,
  requestMetadata map<string,string>,
  input  struct<inputContentType:string, inputBodyS3Path:string, inputTokenCount:int,
                 cacheReadInputTokenCount:int, cacheWriteInputTokenCount:int>,
  output struct<outputContentType:string, outputTokenCount:int>
)
ROW FORMAT SERDE 'org.openx.data.jsonserde.JsonSerDe'
STORED AS INPUTFORMAT  'org.apache.hadoop.mapred.TextInputFormat'
          OUTPUTFORMAT 'org.apache.hadoop.hive.ql.io.IgnoreKeyTextOutputFormat'
LOCATION 's3://<bucket>/model-logs/AWSLogs/<account-id>/BedrockModelInvocationLogs/<region>/';
```

> The date hierarchy is `YYYY/MM/DD/HH` under the region prefix — add Athena **partition
> projection** keyed on that layout to prune scans. With `identity.arn` available you can
> attribute usage per IAM principal directly; `requestMetadata` tags remain useful for
> application-level tenant/team grouping when callers set them.

```sql
-- Top consumers this week (by request-metadata "tenant" tag)
SELECT requestMetadata['tenant'] AS tenant,
       SUM(input.inputTokenCount + output.outputTokenCount) AS total_tokens,
       COUNT(*) AS invocations
FROM bedrock_invocation_logs
WHERE from_iso8601_timestamp("timestamp") >= date_add('day', -7, current_timestamp)
GROUP BY requestMetadata['tenant']
ORDER BY total_tokens DESC
LIMIT 10;

-- Per-model daily cost estimate (Claude Sonnet rates: $3/MTok in, $15/MTok out)
SELECT modelId,
       date(from_iso8601_timestamp("timestamp")) AS day,
       SUM(input.inputTokenCount) * 0.000003 + SUM(output.outputTokenCount) * 0.000015 AS est_usd
FROM bedrock_invocation_logs
WHERE from_iso8601_timestamp("timestamp") >= date_add('day', -30, current_timestamp)
GROUP BY modelId, date(from_iso8601_timestamp("timestamp"))
ORDER BY day DESC, est_usd DESC;
```

---

## 3. EventBridge + Lambda (automated response)

`InvokeModel`, `InvokeModelWithResponseStream`, `Converse`, `ConverseStream` are CloudTrail
**management events** (recorded by default), so no data-event selector is needed. The CloudTrail
record includes `userIdentity.arn`, `sourceIPAddress`, and `errorCode`.

```json
{
  "source": ["aws.bedrock"],
  "detail-type": ["AWS API Call via CloudTrail"],
  "detail": {
    "eventSource": ["bedrock.amazonaws.com"],
    "eventName": ["InvokeModel", "InvokeModelWithResponseStream"],
    "errorCode": ["AccessDeniedException"]
  }
}
```

> For an off-hours check on **successful** calls, drop the `errorCode` filter (match all) and
> branch inside the Lambda, or use a second rule. Cost: AWS service (management) events are free
> to ingest on the default bus; custom events are $1.00/million. Lambda billed separately.

---

## 4. AWS Budgets (cost hard-stop)

```bash
aws budgets create-budget \
  --account-id <account-id> \
  --budget '{
    "BudgetName": "bedrock-monthly",
    "BudgetLimit": {"Amount": "5000", "Unit": "USD"},
    "TimeUnit": "MONTHLY",
    "BudgetType": "COST",
    "CostFilters": { "Service": ["Amazon Bedrock"] }
  }' \
  --notifications-with-subscribers '[
    {"Notification": {"NotificationType":"ACTUAL","ComparisonOperator":"GREATER_THAN","Threshold":80,"ThresholdType":"PERCENTAGE"},
     "Subscribers":[{"SubscriptionType":"EMAIL","Address":"finops@example.com"}]},
    {"Notification": {"NotificationType":"FORECASTED","ComparisonOperator":"GREATER_THAN","Threshold":100,"ThresholdType":"PERCENTAGE"},
     "Subscribers":[{"SubscriptionType":"EMAIL","Address":"finops@example.com"}]}
  ]'
```

Budget *monitoring* is free; Budget *Actions* are free for the first 2 action-enabled budgets,
then $0.10/day each. A Budget Action can auto-apply a restrictive IAM policy as a hard stop.

---

## 5. Service Quotas (rate safety net)

Default per-model/Region rate limits return HTTP 429 `ThrottlingException` on breach. Check the
live value in the Service Quotas console rather than assuming a fixed number; some quotas are
adjustable via a quota-increase request, others are fixed.

---

## Recommended layered strategy

| Layer | Tool | Purpose |
|---|---|---|
| Real-time detection | CloudWatch Alarms | threshold alerts on token metrics |
| Anomaly detection | Cost Anomaly Detection | ML spend-pattern deviation |
| Automated response | EventBridge + Lambda | auto-notify / contain |
| Cost protection | AWS Budgets + Actions | hard spending cap |
| Rate limiting | Service Quotas | hard API rate limit (429) |
| Deep analytics | Model Invocation Logs → Athena | forensics, compliance, dashboards |
| Quick investigation | CloudWatch Logs Insights | ad-hoc CloudTrail queries |

---

## Sources (official documentation)

- Bedrock CloudWatch metrics — https://docs.aws.amazon.com/bedrock/latest/userguide/monitoring-cw.html
- Model invocation logging (schema, destinations) — https://docs.aws.amazon.com/bedrock/latest/userguide/model-invocation-logging.html
- `put-model-invocation-logging-configuration` — https://docs.aws.amazon.com/cli/latest/reference/bedrock/put-model-invocation-logging-configuration.html
- Cost Anomaly Detection — https://docs.aws.amazon.com/cost-management/latest/userguide/getting-started-ad.html
- `ce create-anomaly-monitor` — https://docs.aws.amazon.com/cli/latest/reference/ce/create-anomaly-monitor.html
- `ce create-anomaly-subscription` — https://docs.aws.amazon.com/cli/latest/reference/ce/create-anomaly-subscription.html
- `budgets create-budget` — https://docs.aws.amazon.com/cli/latest/reference/budgets/create-budget.html
- AWS Budgets pricing — https://aws.amazon.com/aws-cost-management/aws-budgets/pricing/
- EventBridge pricing — https://aws.amazon.com/eventbridge/pricing/
- Athena pricing — https://aws.amazon.com/athena/pricing/
- Athena JSON / OpenX SerDe — https://docs.aws.amazon.com/athena/latest/ug/querying-JSON.html
- Athena partition projection — https://docs.aws.amazon.com/athena/latest/ug/partition-projection.html
- CloudWatch pricing (Logs Insights $0.005/GB scanned) — https://aws.amazon.com/cloudwatch/pricing/
- Bedrock CloudTrail integration — https://docs.aws.amazon.com/bedrock/latest/userguide/logging-using-cloudtrail.html
- Claude pricing ($3/$15 per MTok Sonnet) — https://platform.claude.com/docs/en/docs/about-claude/pricing

> Prices and quotas vary by Region and change over time; reconfirm against the linked pages
> before relying on specific figures.
