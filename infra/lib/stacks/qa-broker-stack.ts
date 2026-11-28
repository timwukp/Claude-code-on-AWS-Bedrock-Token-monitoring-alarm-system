import * as fs from 'fs';
import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import { EnvConfig } from '../config';

/** The broker's code lives with the agents that call it (ci-agent/), not in backend/. */
export const CI_AGENT_ROOT = path.join(__dirname, '..', '..', '..', 'ci-agent');
/** Exactly what the Lambda ships: the broker, the lease module it reads the lease with, and their two specs. */
export const BROKER_FILES = ['qa_reset_broker.py', 'qa_reset_broker_spec.json', 'harness_lock.py', 'harness_lock_spec.json'];
/** The name the UI QA workflow and qa_agent.py call (their default; QA_BROKER_FUNCTION overrides it). */
export const QA_BROKER_FUNCTION = 'qa-login-reset';
export const QA_BROKER_ROLE = 'qa-login-reset-role';
export const CI_INVOKE_POLICY = 'QaResetBrokerInvoke';

/** The lease key, read from the lock spec so the stack and the lock code cannot disagree. */
export const LOCK_KEY: string = JSON.parse(fs.readFileSync(path.join(CI_AGENT_ROOT, 'harness_lock_spec.json'), 'utf8')).key;

interface Props extends cdk.StackProps {
  cfg: EnvConfig;
  /** The dev app's pool (AuthStack). The broker resets passwords in this pool only. */
  userPool: cognito.IUserPool;
}

/**
 * The QA reset broker (feature-53): gives the two QA logins of the shared dev app a new password for every UI QA run.
 *
 * Its role (ci-agent/qa_reset_broker_spec.json has the rules):
 * - resets a password and signs a user out, in this pool only;
 * - reads and writes the two QA login secrets;
 * - reads the UI harness lease, without writing it.
 *
 * The CI role that runs the UI QA workflow may invoke it, and has no Cognito or secret-write rights of its own.
 * The usernames come from the untracked env config (`qaBroker.logins`), never from a request.
 */
export class QaBrokerStack extends cdk.Stack {
  public readonly fn: lambda.Function;

  constructor(scope: Construct, id: string, props: Props) {
    super(scope, id, props);
    const qb = props.cfg.qaBroker;
    if (!qb) throw new Error('QaBrokerStack needs cfg.qaBroker (see example.env.json)');
    const names = Object.keys(qb.logins);
    if (names.length === 0) throw new Error('cfg.qaBroker.logins is empty: the broker would have nothing to rotate');
    for (const [name, l] of Object.entries(qb.logins)) {
      if (!l.secretName || !l.username) throw new Error(`cfg.qaBroker.logins.${name} needs secretName and username`);
    }
    const bucket = qb.lockBucketName ?? `token-monitor-qa-reports-${props.cfg.account}`;
    // A secret's ARN ends in a random 6-character suffix; `-??????` matches exactly that, and no longer name.
    const secretArns = Object.values(qb.logins).map((l) =>
      `arn:${cdk.Aws.PARTITION}:secretsmanager:${this.region}:${this.account}:secret:${l.secretName}-??????`);

    const role = new iam.Role(this, 'BrokerRole', {
      roleName: QA_BROKER_ROLE,
      description: 'feature-53 QA reset broker',
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com', { conditions: { StringEquals: { 'aws:SourceAccount': this.account } } }),
    });
    role.addToPolicy(new iam.PolicyStatement({
      sid: 'ResetOnlyInThisPool',
      actions: ['cognito-idp:AdminSetUserPassword', 'cognito-idp:AdminUserGlobalSignOut'],
      resources: [props.userPool.userPoolArn],
    }));
    role.addToPolicy(new iam.PolicyStatement({
      sid: 'TheQaLoginSecrets',
      actions: ['secretsmanager:GetSecretValue', 'secretsmanager:PutSecretValue', 'secretsmanager:UpdateSecretVersionStage'],
      resources: secretArns,
    }));
    role.addToPolicy(new iam.PolicyStatement({
      sid: 'ReadTheLease',
      actions: ['s3:GetObject'],
      resources: [`arn:${cdk.Aws.PARTITION}:s3:::${bucket}/${LOCK_KEY}`],
    }));

    const logGroup = new logs.LogGroup(this, 'BrokerLogs', { retention: logs.RetentionDays.THREE_MONTHS, removalPolicy: cdk.RemovalPolicy.DESTROY });
    logGroup.grantWrite(role);

    this.fn = new lambda.Function(this, 'Broker', {
      functionName: QA_BROKER_FUNCTION,
      description: 'feature-53: per-run passwords for the QA logins; rotates only for the holder of the UI harness lease',
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'qa_reset_broker.lambda_handler',
      // Everything in ci-agent/ is excluded except the four files the handler imports or reads.
      code: lambda.Code.fromAsset(CI_AGENT_ROOT, { exclude: ['*', '.*', ...BROKER_FILES.map((f) => `!${f}`)] }),
      role,
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      logGroup,
      environment: {
        // From the pool ARN (arn:...:userpool/<id>): AuthStack already exports the ARN, and importing its Ref too would
        // add an export, which would mean redeploying AuthStack before this stack.
        QA_BROKER_USER_POOL_ID: cdk.Fn.select(1, cdk.Fn.split('/', props.userPool.userPoolArn)),
        QA_BROKER_LOCK_BUCKET: bucket,
        QA_BROKER_SECRET_MAP: JSON.stringify(Object.fromEntries(Object.entries(qb.logins).map(
          ([name, l]) => [name, { secretId: l.secretName, username: l.username }]))),
      },
    });

    // The CI role is created outside this app (GitHub OIDC). Attach one named policy to it: invoke this function.
    const ciRole = iam.Role.fromRoleName(this, 'CiRole', qb.ciRoleName);
    new iam.Policy(this, 'CiInvokeBroker', {
      policyName: CI_INVOKE_POLICY,
      roles: [ciRole],
      statements: [new iam.PolicyStatement({ sid: 'InvokeTheResetBroker', actions: ['lambda:InvokeFunction'], resources: [this.fn.functionArn] })],
    });

    new cdk.CfnOutput(this, 'BrokerFunctionName', { value: this.fn.functionName });
  }
}
