import { Match, Template } from 'aws-cdk-lib/assertions';
import { cfg, synthApp } from './synth';

// Bedrock invocation logging now writes to BOTH destinations: S3 (the aggregator and the ETL still
// read it) and CloudWatch Logs (the lakehouse Firehose reads it). Bodies > 100 KB go to the
// dedicated bodies bucket, never under a table prefix again (qa F-PR75-001).
describe('LoggingStack', () => {
  const { logging } = synthApp();
  const template = Template.fromStack(logging);

  it('keeps the S3 destination and adds the CloudWatch Logs destination with large-body delivery to the bodies bucket', () => {
    template.hasResourceProperties('AWS::Bedrock::ModelInvocationLoggingConfiguration', {
      LoggingConfig: Match.objectLike({
        S3Config: Match.objectLike({ KeyPrefix: 'model-logs/' }),
        CloudWatchConfig: Match.objectLike({
          LogGroupName: Match.anyValue(), // cross-stack import of the Lakehouse log group
          RoleArn: Match.anyValue(),
          LargeDataDeliveryS3Config: Match.objectLike({ KeyPrefix: 'bodies/' }),
        }),
        TextDataDeliveryEnabled: true,
      }),
    });
  });

  it('creates the CloudTrail trail by default and skips it when logging.createTrail is false', () => {
    template.resourceCountIs('AWS::CloudTrail::Trail', 1); // ci.json does not set logging.createTrail
    const { logging: noTrail } = synthApp({ ...cfg, logging: { createTrail: false } });
    Template.fromStack(noTrail).resourceCountIs('AWS::CloudTrail::Trail', 0);
  });
});
