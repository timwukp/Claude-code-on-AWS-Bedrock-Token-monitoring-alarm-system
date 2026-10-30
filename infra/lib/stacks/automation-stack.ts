import * as cdk from 'aws-cdk-lib';
import * as cwActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subs from 'aws-cdk-lib/aws-sns-subscriptions';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as budgets from 'aws-cdk-lib/aws-budgets';
import * as ce from 'aws-cdk-lib/aws-ce';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { EnvConfig } from '../config';
import { BACKEND_ROOT, BACKEND_LOCK, lambdaEntry } from './paths';
import { DataTables } from './data-stack';

interface Props extends cdk.StackProps {
  cfg: EnvConfig;
  tables: DataTables;
}

/**
 * Event-driven automation + native cost governance:
 *  - CloudTrail → EventBridge → anomaly-response Lambda (notify, optional containment)
 *  - SNS alert topic (also the Cost Anomaly Detection IMMEDIATE target)
 *  - AWS Budgets (actual + forecasted)
 * (Security + Cost pillars.)
 */
export class AutomationStack extends cdk.Stack {
  public readonly alertTopic: sns.Topic;

  constructor(scope: Construct, id: string, props: Props) {
    super(scope, id, props);
    const { cfg, tables } = props;

    this.alertTopic = new sns.Topic(this, 'AlertTopic', { topicName: `bedrock-security-alerts-${cfg.env}` });
    cfg.governance.alertEmails.forEach((e, i) =>
      this.alertTopic.addSubscription(new subs.EmailSubscription(e)),
    );

    const dlq = new sqs.Queue(this, 'ResponseDlq', { retentionPeriod: cdk.Duration.days(14) });

    const enf = cfg.enforcement;
    const enforcementEnabled =
      cfg.enableAutoContainment && !!enf?.budgetActionThresholdPct && !!enf.budgetActionRoleArns?.length;

    // Deny-Bedrock managed policy, shared by the Budget Action (#4) and the Lambda containment
    // (#5). Created only when enforcement is enabled (opt-in; Security pillar).
    const denyPolicy = enforcementEnabled
      ? new iam.ManagedPolicy(this, 'BedrockDenyPolicy', {
          managedPolicyName: `tums-bedrock-denied-${cfg.env}`,
          statements: [new iam.PolicyStatement({
            effect: iam.Effect.DENY,
            actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream', 'bedrock:Converse', 'bedrock:ConverseStream'],
            resources: ['*'],
          })],
        })
      : undefined;

    const responseFn = new NodejsFunction(this, 'AnomalyResponseFn', {
      runtime: lambda.Runtime.NODEJS_22_X,
      entry: lambdaEntry('anomaly-response', 'index.ts'),
      projectRoot: BACKEND_ROOT,
      depsLockFilePath: BACKEND_LOCK,
      handler: 'handler',
      timeout: cdk.Duration.seconds(30),
      tracing: lambda.Tracing.ACTIVE,
      deadLetterQueue: dlq,
      logGroup: new logs.LogGroup(this, 'AnomalyResponseFnLogs', { retention: logs.RetentionDays.THREE_MONTHS, removalPolicy: cdk.RemovalPolicy.DESTROY }),
      environment: {
        ALERT_TOPIC_ARN: this.alertTopic.topicArn,
        ANOMALIES_TABLE: tables.anomalies.tableName,
        ENABLE_AUTO_CONTAINMENT: String(cfg.enableAutoContainment), // default false
        DENY_POLICY_ARN: denyPolicy?.managedPolicyArn ?? '',
        // Never contain these principals (admins, operators). Before feature-49 this was the SAME list as the
        // targets below, so the only roles the Lambda could contain were the ones marked "never contain".
        CONTAINMENT_ALLOWLIST: (enf?.neverContainArns ?? []).join(','),
        // The roles the deny policy may be attached to — exactly the resources granted below.
        CONTAINMENT_TARGETS: (enf?.budgetActionRoleArns ?? []).join(','),
        CONTAINMENT_MIN_EVENTS: String(enf?.containmentMinEvents ?? 3),
        CONTAINMENT_WINDOW_MIN: String(enf?.containmentWindowMinutes ?? 10),
      },
    });
    // A target that is also never-contain is a misconfiguration (it would silently neutralise the hard-stop);
    // a target that is not a role ARN can never be attached to. Fail at synth, not at the first incident.
    const norm = (a: string) => a.replace(/^arn:(aws[a-z-]*):sts::(\d{12}):assumed-role\/([^/]+)\/[^/]+$/i, 'arn:$1:iam::$2:role/$3').toLowerCase();
    const never = new Set((enf?.neverContainArns ?? []).map(norm));
    for (const t of enf?.budgetActionRoleArns ?? []) {
      if (never.has(norm(t))) throw new Error(`enforcement: ${t} is both a containment target and in neverContainArns`);
      if (!/^arn:aws[a-z-]*:iam::\d{12}:role\//.test(t)) throw new Error(`enforcement.budgetActionRoleArns: ${t} is not an IAM role ARN (users cannot be Budget Action targets)`);
    }
    this.alertTopic.grantPublish(responseFn);
    responseFn.metricErrors({ period: cdk.Duration.minutes(15), statistic: 'Sum' })
      .createAlarm(this, 'AnomalyResponseErrors', { threshold: 1, evaluationPeriods: 1, alarmDescription: `TUMS ${cfg.env}: AnomalyResponseFn errors`, treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING })
      .addAlarmAction(new cwActions.SnsAction(this.alertTopic));
    tables.anomalies.grantWriteData(responseFn); // persist alerts for the dashboard feed

    // #5: allow the Lambda to attach the deny policy to a contained principal (scoped to the
    // configured target roles only). Only granted when enforcement is enabled.
    if (enforcementEnabled && denyPolicy) {
      responseFn.addToRolePolicy(new iam.PolicyStatement({
        actions: ['iam:AttachRolePolicy', 'iam:AttachUserPolicy'],
        resources: enf!.budgetActionRoleArns!,
        conditions: { ArnEquals: { 'iam:PolicyARN': denyPolicy.managedPolicyArn } },
      }));
    }

    // Bedrock InvokeModel/Converse are CloudTrail management events (default-on) → match directly.
    new events.Rule(this, 'AccessDeniedRule', {
      eventPattern: {
        source: ['aws.bedrock'],
        detailType: ['AWS API Call via CloudTrail'],
        detail: {
          eventSource: ['bedrock.amazonaws.com'],
          eventName: ['InvokeModel', 'InvokeModelWithResponseStream'],
          errorCode: ['AccessDeniedException'],
        },
      },
      targets: [new targets.LambdaFunction(responseFn, { deadLetterQueue: dlq })],
    });

    // AWS Budgets — actual (80%) + forecasted (100%) on Bedrock service spend.
    // Bedrock bills under THREE service names: every Claude / OpenAI model line is "Amazon Bedrock Service"
    // (MTD 2026-10 $4,385.80), "Amazon Bedrock" carries Guardrails and Nova ($0.82), AgentCore has its own.
    // Until feature-40 (qa F-PR73-006) the filter named only "Amazon Bedrock", so the budget — and the
    // Budget Action hard-stop built on it — watched 0.02% of the spend and read "on track" at 4.4× the limit.
    const bedrockBudget = new budgets.CfnBudget(this, 'BedrockBudget', {
      budget: {
        budgetName: `bedrock-monthly-${cfg.env}`,
        budgetType: 'COST',
        timeUnit: 'MONTHLY',
        budgetLimit: { amount: cfg.governance.monthlyBudgetUsd, unit: 'USD' },
        costFilters: { Service: ['Amazon Bedrock', 'Amazon Bedrock Service', 'Amazon Bedrock AgentCore'] },
      },
      notificationsWithSubscribers: [
        {
          notification: { notificationType: 'ACTUAL', comparisonOperator: 'GREATER_THAN', threshold: 80, thresholdType: 'PERCENTAGE' },
          subscribers: cfg.governance.alertEmails.map((address) => ({ subscriptionType: 'EMAIL', address })),
        },
        {
          notification: { notificationType: 'FORECASTED', comparisonOperator: 'GREATER_THAN', threshold: 100, thresholdType: 'PERCENTAGE' },
          subscribers: cfg.governance.alertEmails.map((address) => ({ subscriptionType: 'EMAIL', address })),
        },
      ],
    });

    // --- #4 Budget Action hard-stop (opt-in) ---
    // When the budget reaches a configured % of the monthly limit, AWS Budgets applies a
    // restrictive IAM policy (deny Bedrock) to the configured role(s) — a real spend-cap freeze.
    // OFF by default (Security pillar). Point budgetActionRoleArns at SCOPED/TEST roles, never an
    // admin identity, to avoid locking yourself out. See docs/GOVERNANCE_FAQ.md §2.
    if (enforcementEnabled && denyPolicy) {
      // Role that AWS Budgets assumes to perform the action.
      const budgetActionRole = new iam.Role(this, 'BudgetActionRole', {
        assumedBy: new iam.ServicePrincipal('budgets.amazonaws.com'),
        description: 'Assumed by AWS Budgets to apply the Bedrock deny policy at the spend cap',
      });
      budgetActionRole.addToPolicy(new iam.PolicyStatement({
        actions: ['iam:AttachRolePolicy', 'iam:DetachRolePolicy'],
        resources: enf!.budgetActionRoleArns!,
      }));

      new budgets.CfnBudgetsAction(this, 'BedrockHardStopAction', {
        budgetName: bedrockBudget.ref,
        notificationType: 'ACTUAL',
        actionType: 'APPLY_IAM_POLICY',
        actionThreshold: { type: 'PERCENTAGE', value: enf!.budgetActionThresholdPct! },
        approvalModel: 'AUTOMATIC',
        executionRoleArn: budgetActionRole.roleArn,
        definition: {
          iamActionDefinition: {
            policyArn: denyPolicy.managedPolicyArn,
            roles: enf!.budgetActionRoleArns!.map((arn) => arn.split('/').pop()!),
          },
        },
        subscribers: cfg.governance.alertEmails.map((address) => ({ type: 'EMAIL', address })),
      });

      new cdk.CfnOutput(this, 'BudgetActionPolicyArn', { value: denyPolicy.managedPolicyArn });
    }

    // --- Cost Anomaly Detection (ML) — created as code ---
    // A DIMENSIONAL/SERVICE monitor auto-learns the spend baseline; an IMMEDIATE subscription
    // routes detected anomalies to the SNS alert topic. Verified params:
    //   docs/MONITORING_APPROACH.md §1 (Threshold deprecated → ThresholdExpression).
    const anomalyMonitor = new ce.CfnAnomalyMonitor(this, 'SpendAnomalyMonitor', {
      monitorName: `bedrock-spend-anomaly-${cfg.env}`,
      monitorType: 'DIMENSIONAL',
      monitorDimension: 'SERVICE',
    });

    // Cost Anomaly Detection publishes via the cost-alerts service principal; allow it on the topic.
    this.alertTopic.addToResourcePolicy(new iam.PolicyStatement({
      sid: 'AllowCostAnomalyDetectionPublish',
      principals: [new iam.ServicePrincipal('costalerts.amazonaws.com')],
      actions: ['sns:Publish'],
      resources: [this.alertTopic.topicArn],
    }));

    new ce.CfnAnomalySubscription(this, 'SpendAnomalySubscription', {
      subscriptionName: `bedrock-anomaly-alerts-${cfg.env}`,
      frequency: 'IMMEDIATE', // IMMEDIATE → SNS (DAILY/WEEKLY would require EMAIL)
      monitorArnList: [anomalyMonitor.attrMonitorArn],
      subscribers: [{ type: 'SNS', address: this.alertTopic.topicArn }],
      // ThresholdExpression (Threshold is deprecated): alert when absolute impact ≥ configured USD.
      thresholdExpression: JSON.stringify({
        Dimensions: {
          Key: 'ANOMALY_TOTAL_IMPACT_ABSOLUTE',
          MatchOptions: ['GREATER_THAN_OR_EQUAL'],
          Values: [String(cfg.governance.anomalyImpactUsd)],
        },
      }),
    });

    new cdk.CfnOutput(this, 'AlertTopicArn', { value: this.alertTopic.topicArn });
    new cdk.CfnOutput(this, 'AnomalyMonitorArn', { value: anomalyMonitor.attrMonitorArn });
  }
}
