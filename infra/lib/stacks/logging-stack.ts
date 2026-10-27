import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as cloudtrail from 'aws-cdk-lib/aws-cloudtrail';
import { Construct } from 'constructs';
import { EnvConfig } from '../config';

interface Props extends cdk.StackProps {
  cfg: EnvConfig;
  rawLogBucket: s3.Bucket;
  /** Lakehouse P1: the CloudWatch Logs destination the Firehose reads, and where > 100 KB bodies go. */
  bedrockLogGroup: logs.ILogGroup;
  bedrockLogsRole: iam.IRole;
  bodiesBucket: s3.IBucket;
}

/**
 * Wires up the data sources the platform consumes:
 *  - Bedrock Model Invocation Logging → raw S3 bucket (aggregator + ETL) AND CloudWatch Logs
 *    (lakehouse Firehose), with > 100 KB bodies delivered to the dedicated bodies bucket
 *  - CloudTrail trail (InvokeModel/Converse are management events, on by default)
 *
 * (Security/Operational Excellence pillars — full auditability.)
 */
export class LoggingStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: Props) {
    super(scope, id, props);
    const { cfg, rawLogBucket, bedrockLogGroup, bedrockLogsRole, bodiesBucket } = props;

    // Bedrock model invocation logging to S3 AND CloudWatch Logs. Field schema & path verified in docs.
    // The S3 destination stays until the aggregator reads from the lakehouse; the CloudWatch destination
    // feeds Firehose → bronze and routes large bodies away from any table prefix (qa F-PR75-001).
    new cdk.CfnResource(this, 'ModelInvocationLogging', {
      type: 'AWS::Bedrock::ModelInvocationLoggingConfiguration',
      // NOTE: as of writing, enabling logging is commonly done via
      // `aws bedrock put-model-invocation-logging-configuration` (see docs/MONITORING_APPROACH.md).
      // If the L1 resource is unavailable in your CDK version, run the CLI step in scripts/.
      properties: {
        LoggingConfig: {
          S3Config: { BucketName: rawLogBucket.bucketName, KeyPrefix: 'model-logs/' },
          CloudWatchConfig: {
            LogGroupName: bedrockLogGroup.logGroupName,
            RoleArn: bedrockLogsRole.roleArn,
            LargeDataDeliveryS3Config: { BucketName: bodiesBucket.bucketName, KeyPrefix: 'bodies/' },
          },
          TextDataDeliveryEnabled: true,
          EmbeddingDataDeliveryEnabled: false,
          ImageDataDeliveryEnabled: false,
        },
      },
    });

    // CloudTrail — management events captured by default; trail persists them to S3. Accounts that
    // already run an organisation/multi-region trail set logging.createTrail=false (a second trail
    // only adds S3 cost); EventBridge rules do not need a trail either way.
    if (cfg.logging?.createTrail !== false) {
      new cloudtrail.Trail(this, 'Trail', {
        isMultiRegionTrail: true,
        includeGlobalServiceEvents: true,
        enableFileValidation: true,
      });
    }
    // TODO: add advanced event selectors here ONLY if you also need Bedrock *data* events
    // (e.g. InvokeModelWithBidirectionalStream, Agents/KnowledgeBase) — these are off by default.

    new cdk.CfnOutput(this, 'RawLogBucketName', { value: rawLogBucket.bucketName });
  }
}
