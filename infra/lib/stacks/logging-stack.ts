import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as cloudtrail from 'aws-cdk-lib/aws-cloudtrail';
import * as cr from 'aws-cdk-lib/custom-resources';
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
    // There is NO CloudFormation type for this ("AWS::Bedrock::ModelInvocationLoggingConfiguration" is
    // rejected as unrecognised — the reason this stack had never deployed), so the account-level
    // setting is applied through the API on create and update. Deliberately no onDelete: tearing a
    // stack down must never switch invocation logging off.
    const loggingConfig = {
      s3Config: { bucketName: rawLogBucket.bucketName, keyPrefix: 'model-logs/' },
      cloudWatchConfig: {
        logGroupName: bedrockLogGroup.logGroupName,
        roleArn: bedrockLogsRole.roleArn,
        largeDataDeliveryS3Config: { bucketName: bodiesBucket.bucketName, keyPrefix: 'bodies/' },
      },
      textDataDeliveryEnabled: true,
      imageDataDeliveryEnabled: false,
      embeddingDataDeliveryEnabled: false,
      videoDataDeliveryEnabled: true,
    };
    const putLogging = {
      service: 'Bedrock',
      action: 'putModelInvocationLoggingConfiguration',
      parameters: { loggingConfig },
      physicalResourceId: cr.PhysicalResourceId.of(`bedrock-invocation-logging-${cfg.env}`),
    };
    new cr.AwsCustomResource(this, 'ModelInvocationLogging', {
      resourceType: 'Custom::AWS',
      onCreate: putLogging,
      onUpdate: putLogging,
      installLatestAwsSdk: false,
      policy: cr.AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({ actions: ['bedrock:PutModelInvocationLoggingConfiguration', 'bedrock:GetModelInvocationLoggingConfiguration'], resources: ['*'] }),
        // Bedrock validates the CloudWatch role at PUT time and attaches bucket policies on the caller's behalf.
        new iam.PolicyStatement({ actions: ['iam:PassRole'], resources: [bedrockLogsRole.roleArn] }),
        new iam.PolicyStatement({ actions: ['s3:GetBucketPolicy', 's3:PutBucketPolicy'], resources: [rawLogBucket.bucketArn, bodiesBucket.bucketArn] }),
      ]),
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
