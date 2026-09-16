import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';
import { EnvConfig } from '../config';
import { DataTables } from './data-stack';
import { BACKEND_ROOT, BACKEND_LOCK, lambdaEntry } from './paths';

interface Props extends cdk.StackProps {
  cfg: EnvConfig;
  tables: DataTables;
}

export const DEFAULT_GITHUB_TOKEN_SECRET = 'token-monitor-demo/github-token';

/**
 * DORA metrics collection: a scheduled Lambda pulls merged PRs / incident issues from GitHub for
 * the admin-managed list of repos into the `tums-dora` table, plus the Secrets Manager secret
 * that holds the GitHub token. Kept out of the Etl stack (which needs a VPC + Docker image and
 * is optional to deploy) so it is small and independently deployable (Operational Excellence).
 *
 * The secret is created with a placeholder value; an operator sets the real PAT once:
 *   aws secretsmanager put-secret-value --secret-id token-monitor-demo/github-token --secret-string ghp_...
 * Until then the collector marks repos "token-not-configured" and the dashboard says so.
 */
export class DoraStack extends cdk.Stack {
  public readonly collectorFn: NodejsFunction;
  public readonly githubSecret: secretsmanager.Secret;

  constructor(scope: Construct, id: string, props: Props) {
    super(scope, id, props);
    const { cfg, tables } = props;
    const secretName = cfg.dora?.githubTokenSecretName ?? DEFAULT_GITHUB_TOKEN_SECRET;

    // Placeholder on purpose (not a generated random string): the collector recognises
    // REPLACE_ME and reports "token not configured" instead of hammering GitHub with 401s.
    this.githubSecret = new secretsmanager.Secret(this, 'GithubToken', {
      secretName,
      description: 'GitHub fine-grained PAT (read-only, public repos) for the DORA collector. Replace the placeholder.',
      secretStringValue: cdk.SecretValue.unsafePlainText('REPLACE_ME'),
      removalPolicy: cdk.RemovalPolicy.RETAIN, // never lose an operator-entered token on stack delete
    });

    this.collectorFn = new NodejsFunction(this, 'CollectorFn', {
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: lambdaEntry('dora', 'collector.ts'),
      projectRoot: BACKEND_ROOT,
      depsLockFilePath: BACKEND_LOCK,
      handler: 'handler',
      timeout: cdk.Duration.minutes(5),
      memorySize: 512,
      tracing: lambda.Tracing.ACTIVE,
      environment: {
        DORA_TABLE: tables.dora.tableName,
        GITHUB_TOKEN_SECRET_NAME: secretName,
        DORA_SEED_REPOS: (cfg.dora?.seedRepos ?? []).join(','),
        DORA_BACKFILL_DAYS: String(cfg.dora?.backfillDays ?? 180),
      },
      bundling: { minify: true, sourceMap: true },
    });
    tables.dora.grantReadWriteData(this.collectorFn);
    this.githubSecret.grantRead(this.collectorFn);

    new events.Rule(this, 'CollectorSchedule', {
      description: 'Refresh DORA inputs from GitHub',
      schedule: events.Schedule.rate(cdk.Duration.hours(cfg.dora?.scheduleHours ?? 6)),
      targets: [new targets.LambdaFunction(this.collectorFn)],
    });

    new cdk.CfnOutput(this, 'GithubTokenSecretName', { value: secretName });
    new cdk.CfnOutput(this, 'CollectorFunctionName', { value: this.collectorFn.functionName });
  }
}
