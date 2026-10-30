import { Match, Template } from 'aws-cdk-lib/assertions';
import { cfg, synthApp } from './synth';

// Bedrock invocation logging now writes to BOTH destinations: S3 (the aggregator and the ETL still
// read it) and CloudWatch Logs (the lakehouse Firehose reads it). Bodies > 100 KB go to the
// dedicated bodies bucket, never under a table prefix again (qa F-PR75-001).
describe('LoggingStack', () => {
  const { logging } = synthApp();
  const template = Template.fromStack(logging);

  it('configures Bedrock logging through a custom resource (the CFN type does not exist): S3 kept, CloudWatch added, bodies to the bodies bucket', () => {
    template.resourceCountIs('AWS::Bedrock::ModelInvocationLoggingConfiguration', 0);
    const crs = Object.values(template.findResources('Custom::AWS')).map((r: any) => r.Properties);
    expect(crs).toHaveLength(1);
    const create = JSON.stringify(crs[0].Create);
    const update = JSON.stringify(crs[0].Update);
    for (const s of [create, update]) {
      expect(s).toContain('putModelInvocationLoggingConfiguration');
      expect(s).toContain('model-logs/');
      expect(s).toContain('cloudWatchConfig');
      expect(s).toContain('largeDataDeliveryS3Config');
      expect(s).toContain('bodies/');
      expect(s).toMatch(/textDataDeliveryEnabled\\+":true/);
    }
    expect(crs[0].Delete).toBeUndefined(); // a stack delete must never switch invocation logging off
    const policies = JSON.stringify(Object.values(template.findResources('AWS::IAM::Policy')).map((p: any) => p.Properties.PolicyDocument.Statement));
    expect(policies).toContain('bedrock:PutModelInvocationLoggingConfiguration');
    expect(policies).toContain('iam:PassRole');
    expect(policies).toContain('s3:PutBucketPolicy');
  });

  it('creates the CloudTrail trail by default and skips it when logging.createTrail is false', () => {
    template.resourceCountIs('AWS::CloudTrail::Trail', 1); // ci.json does not set logging.createTrail
    const { logging: noTrail } = synthApp({ ...cfg, logging: { createTrail: false } });
    Template.fromStack(noTrail).resourceCountIs('AWS::CloudTrail::Trail', 0);
  });
});
