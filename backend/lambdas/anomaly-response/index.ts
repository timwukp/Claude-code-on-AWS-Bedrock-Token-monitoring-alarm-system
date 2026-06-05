import { SNSClient, PublishCommand } from '@aws-sdk/client-sns';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { IAMClient, AttachRolePolicyCommand, AttachUserPolicyCommand } from '@aws-sdk/client-iam';
import { decideContainment } from './containment';

const sns = new SNSClient({});
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const iam = new IAMClient({});
const TOPIC = process.env.ALERT_TOPIC_ARN!;
const ANOMALIES_TABLE = process.env.ANOMALIES_TABLE;
const AUTO_CONTAINMENT = process.env.ENABLE_AUTO_CONTAINMENT === 'true';
// Deny policy attached to a contained principal (#5). Set by the stack when enforcement is on.
const DENY_POLICY_ARN = process.env.DENY_POLICY_ARN;
// Principals that must never be contained (admins, this Lambda's own role). Comma-separated ARNs.
const CONTAINMENT_ALLOWLIST = (process.env.CONTAINMENT_ALLOWLIST ?? '').split(',').map((s) => s.trim()).filter(Boolean);

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
    await maybeContain(userArn, eventTime);
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

/**
 * Scoped auto-containment (#5): attach the deny policy to the offending principal — only when
 * enabled, parseable, not allow-listed, and a deny policy is configured. Conservative by design
 * to avoid self-lockout; failures are logged + alerted, never thrown (best-effort containment).
 */
async function maybeContain(principalArn: string, eventTime: string): Promise<void> {
  const decision = decideContainment({
    enabled: AUTO_CONTAINMENT && !!DENY_POLICY_ARN,
    principalArn,
    allowList: CONTAINMENT_ALLOWLIST,
  });
  if (!decision.act || !decision.target) {
    console.log(`Containment skipped: ${decision.reason}`);
    return;
  }
  try {
    if (decision.target.type === 'role') {
      await iam.send(new AttachRolePolicyCommand({ RoleName: decision.target.name, PolicyArn: DENY_POLICY_ARN }));
    } else {
      await iam.send(new AttachUserPolicyCommand({ UserName: decision.target.name, PolicyArn: DENY_POLICY_ARN }));
    }
    await raise('CRITICAL', principalArn, eventTime, {
      type: 'Contained',
      message: `Auto-containment applied: deny policy attached to ${decision.target.type} ${decision.target.name}.`,
      eventName: 'Containment', sourceIp: 'n/a',
    });
  } catch (err) {
    console.error('Containment failed:', err);
    await raise('CRITICAL', principalArn, eventTime, {
      type: 'ContainmentFailed',
      message: `Auto-containment FAILED for ${principalArn}: ${String(err)}. Manual review required.`,
      eventName: 'Containment', sourceIp: 'n/a',
    });
  }
}

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
