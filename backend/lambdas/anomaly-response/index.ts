import { SNSClient, PublishCommand } from '@aws-sdk/client-sns';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';

const sns = new SNSClient({});
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TOPIC = process.env.ALERT_TOPIC_ARN!;
const ANOMALIES_TABLE = process.env.ANOMALIES_TABLE;
const AUTO_CONTAINMENT = process.env.ENABLE_AUTO_CONTAINMENT === 'true';

type Severity = 'CRITICAL' | 'WARNING' | 'INFO';

/**
 * Triggered by EventBridge on Bedrock CloudTrail events (management events, default-on).
 * The CloudTrail record carries userIdentity.arn, sourceIPAddress, and errorCode.
 *
 * For each detection it (1) publishes to SNS for notification and (2) records the alert in the
 * anomalies DynamoDB table so the dashboard's Anomalies feed shows it (read by GET /v1/anomalies).
 * Default behaviour is NOTIFY-ONLY; auto-containment is opt-in (Security pillar).
 */
export const handler = async (event: any): Promise<void> => {
  const detail = event.detail ?? {};
  const userArn: string = detail.userIdentity?.arn ?? 'unknown';
  const sourceIp: string = detail.sourceIPAddress ?? 'unknown';
  const errorCode: string = detail.errorCode ?? '';
  const eventName: string = detail.eventName ?? '';
  const eventTime: string = detail.eventTime ?? new Date().toISOString();

  if (errorCode === 'AccessDeniedException') {
    await raise('CRITICAL', userArn, eventTime, {
      type: 'AccessDenied',
      message: `${userArn} got AccessDenied on ${eventName} from ${sourceIp}. Possible credential use from an unexpected location.`,
      eventName, sourceIp,
    });
    if (AUTO_CONTAINMENT) {
      // TODO: implement scoped containment (attach deny policy / disable key) — opt in per tenant.
      console.warn('Auto-containment requested but left as a deliberate TODO.');
    }
    return;
  }

  // Off-hours heuristic (fires when the rule also matches successful calls).
  const hourSgt = (new Date(eventTime).getUTCHours() + 8) % 24;
  if (hourSgt < 6 || hourSgt > 22) {
    await raise('WARNING', userArn, eventTime, {
      type: 'OffHoursUsage',
      message: `Off-hours Bedrock ${eventName} by ${userArn} (~${hourSgt}:00 SGT).`,
      eventName, sourceIp,
    });
  }
};

/** Publish to SNS and persist to the anomalies table (tenant = caller ARN). */
async function raise(
  severity: Severity,
  tenant: string,
  eventTime: string,
  details: { type: string; message: string; eventName: string; sourceIp: string },
): Promise<void> {
  console.log(`${severity}: ${details.message}`);

  await sns.send(new PublishCommand({
    TopicArn: TOPIC,
    Subject: `Bedrock Security Alert [${severity}]`,
    Message: `${severity}: ${details.message}`,
  }));

  if (!ANOMALIES_TABLE) return;
  // sk sorts newest-first when queried with ScanIndexForward:false; suffix keeps it unique.
  const sk = `${eventTime}#${details.type}#${details.sourceIp}`;
  await ddb.send(new PutCommand({
    TableName: ANOMALIES_TABLE,
    Item: {
      pk: `TENANT#${tenant}#ANOMALY`,
      sk,
      severity,
      type: details.type,
      message: details.message,
      eventName: details.eventName,
      sourceIp: details.sourceIp,
      detectedAt: eventTime,
    },
  }));
}
