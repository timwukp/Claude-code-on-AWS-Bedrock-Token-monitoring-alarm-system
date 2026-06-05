import * as cdk from 'aws-cdk-lib';
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
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: lambdaEntry('anomaly-response', 'index.ts'),
      projectRoot: BACKEND_ROOT,
      depsLockFilePath: BACKEND_LOCK,
      handler: 'handler',
      timeout: cdk.Duration.seconds(30),
      tracing: lambda.Tracing.ACTIVE,
      deadLetterQueue: dlq,
      environment: {
        ALERT_TOPIC_ARN: this.alertTopic.topicArn,
        ANOMALIES_TABLE: tables.anomalies.tableName,
        ENABLE_AUTO_CONTAINMENT: String(cfg.enableAutoContainment), // default false
        DENY_POLICY_ARN: denyPolicy?.managedPolicyArn ?? '',
        // Never contain these principals (admins, this Lambda's own role) — avoids self-lockout.
        CONTAINMENT_ALLOWLIST: (enf?.budgetActionRoleArns ?? []).join(','),
      },
    });
    this.alertTopic.grantPublish(responseFn);
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
    const bedrockBudget = new budgets.CfnBudget(this, 'BedrockBudget', {
      budget: {
        budgetName: `bedrock-monthly-${cfg.env}`,
        budgetType: 'COST',
        timeUnit: 'MONTHLY',
        budgetLimit: { amount: cfg.governance.monthlyBudgetUsd, unit: 'USD' },
        costFilters: { Service: ['Amazon Bedrock'] },
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
