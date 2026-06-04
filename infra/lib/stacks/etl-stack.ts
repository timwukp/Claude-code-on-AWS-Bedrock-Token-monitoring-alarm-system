import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as tasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import * as path from 'path';
import { Construct } from 'constructs';
import { EnvConfig } from '../config';
import { DataTables } from './data-stack';
import { BACKEND_ROOT, BACKEND_LOCK, lambdaEntry } from './paths';

interface Props extends cdk.StackProps {
  cfg: EnvConfig;
  vpc: ec2.Vpc;
  rawLogBucket: s3.Bucket;
  curatedBucket: s3.Bucket;
  tables: DataTables;
}

/**
 * Hybrid compute (Performance/Cost pillars):
 *  - frequent, lightweight aggregation: EventBridge cron → Lambda → DynamoDB KPIs
 *  - periodic heavy ETL: Step Functions → Fargate task (compact raw JSON → Parquet, reports)
 */
export class EtlStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: Props) {
    super(scope, id, props);
    const { cfg, vpc, rawLogBucket, curatedBucket, tables } = props;

    // --- Lightweight aggregator (every 15 min) ---
    const aggregatorFn = new NodejsFunction(this, 'AggregatorFn', {
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: lambdaEntry('ingestion', 'aggregator.ts'),
      projectRoot: BACKEND_ROOT,
      depsLockFilePath: BACKEND_LOCK,
      handler: 'handler',
      timeout: cdk.Duration.minutes(5),
      memorySize: 512,
      tracing: lambda.Tracing.ACTIVE,
      environment: {
        AGGREGATES_TABLE: tables.aggregates.tableName,
        RAW_LOG_BUCKET: rawLogBucket.bucketName,
        LOG_PREFIX: 'model-logs/AWSLogs/',
      },
    });
    // Reads the watermark item and writes aggregates → needs read+write.
    tables.aggregates.grantReadWriteData(aggregatorFn);
    // grantRead also grants KMS decrypt on the bucket's CMK (bucket is KMS-encrypted).
    rawLogBucket.grantRead(aggregatorFn);

    new events.Rule(this, 'AggregatorSchedule', {
      schedule: events.Schedule.rate(cdk.Duration.minutes(15)),
      targets: [new targets.LambdaFunction(aggregatorFn)],
    });

    // --- Heavy ETL: Fargate task on a daily Step Functions workflow ---
    const cluster = new ecs.Cluster(this, 'EtlCluster', { vpc });
    const taskDef = new ecs.FargateTaskDefinition(this, 'EtlTask', { cpu: 1024, memoryLimitMiB: 2048 });
    rawLogBucket.grantRead(taskDef.taskRole);
    curatedBucket.grantReadWrite(taskDef.taskRole);

    taskDef.addContainer('EtlContainer', {
      // TODO: build & push backend/analysis Dockerfile; reference the ECR image here.
      image: ecs.ContainerImage.fromAsset(path.join(__dirname, '..', '..', '..', 'backend', 'analysis')),
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'etl' }),
      environment: {
        RAW_LOG_BUCKET: rawLogBucket.bucketName,
        CURATED_BUCKET: curatedBucket.bucketName,
      },
    });

    const runTask = new tasks.EcsRunTask(this, 'RunEtl', {
      integrationPattern: sfn.IntegrationPattern.RUN_JOB,
      cluster,
      taskDefinition: taskDef,
      launchTarget: new tasks.EcsFargateLaunchTarget(),
    });

    const stateMachine = new sfn.StateMachine(this, 'EtlStateMachine', {
      definitionBody: sfn.DefinitionBody.fromChainable(runTask),
      timeout: cdk.Duration.hours(2),
      tracingEnabled: true,
    });

    new events.Rule(this, 'EtlSchedule', {
      schedule: events.Schedule.cron({ hour: '2', minute: '0' }), // 02:00 UTC daily
      targets: [new targets.SfnStateMachine(stateMachine)],
    });
  }
}
