import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cloudtrail from 'aws-cdk-lib/aws-cloudtrail';
import { Construct } from 'constructs';
import { EnvConfig } from '../config';

interface Props extends cdk.StackProps {
  cfg: EnvConfig;
  rawLogBucket: s3.Bucket;
}

/**
 * Wires up the data sources the platform consumes:
 *  - Bedrock Model Invocation Logging → raw S3 bucket
 *  - CloudTrail trail (InvokeModel/Converse are management events, on by default)
 *
 * (Security/Operational Excellence pillars — full auditability.)
 */
export class LoggingStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: Props) {
    super(scope, id, props);
    const { cfg, rawLogBucket } = props;

    // Bedrock model invocation logging to S3. Field schema & path verified in docs.
    new cdk.CfnResource(this, 'ModelInvocationLogging', {
      type: 'AWS::Bedrock::ModelInvocationLoggingConfiguration',
      // NOTE: as of writing, enabling logging is commonly done via
      // `aws bedrock put-model-invocation-logging-configuration` (see docs/MONITORING_APPROACH.md).
      // If the L1 resource is unavailable in your CDK version, run the CLI step in scripts/.
      properties: {
        LoggingConfig: {
          S3Config: { BucketName: rawLogBucket.bucketName, KeyPrefix: 'model-logs/' },
          TextDataDeliveryEnabled: true,
          EmbeddingDataDeliveryEnabled: false,
          ImageDataDeliveryEnabled: false,
        },
      },
    });

    // CloudTrail — management events captured by default; trail persists them to S3.
    new cloudtrail.Trail(this, 'Trail', {
      isMultiRegionTrail: true,
      includeGlobalServiceEvents: true,
      enableFileValidation: true,
    });
    // TODO: add advanced event selectors here ONLY if you also need Bedrock *data* events
    // (e.g. InvokeModelWithBidirectionalStream, Agents/KnowledgeBase) — these are off by default.

    new cdk.CfnOutput(this, 'RawLogBucketName', { value: rawLogBucket.bucketName });
  }
}
