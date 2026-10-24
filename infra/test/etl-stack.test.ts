import { Match, Template } from 'aws-cdk-lib/assertions';
import { dockerImageSources, synthApp } from './synth';

// The daily Fargate ETL failed 90/90 runs from 2026-07-27 to 2026-10-24 with
// `exec /usr/local/bin/python: exec format error` — the image was built on an arm64 laptop and run
// on an x86_64 task — and nothing alarmed. These tests pin both halves of that lesson.
describe('EtlStack', () => {
  const { app, etl } = synthApp();
  const template = Template.fromStack(etl);

  it('builds the ETL container image for the architecture the task runs on', () => {
    const sources = dockerImageSources(app, etl);
    expect(sources).toHaveLength(1);
    expect(sources[0].platform).toBe('linux/amd64');
    template.hasResourceProperties('AWS::ECS::TaskDefinition', {
      RuntimePlatform: { CpuArchitecture: 'X86_64', OperatingSystemFamily: 'LINUX' },
    });
  });

  it('alarms when an ETL state-machine execution fails and routes it to the governance alert topic', () => {
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      Namespace: 'AWS/States',
      MetricName: 'ExecutionsFailed',
      Statistic: 'Sum',
      Threshold: 1,
      ComparisonOperator: 'GreaterThanOrEqualToThreshold',
      TreatMissingData: 'notBreaching',
      Dimensions: [{ Name: 'StateMachineArn', Value: { Ref: Match.stringLikeRegexp('EtlStateMachine') } }],
      AlarmActions: [Match.objectLike({ 'Fn::ImportValue': Match.stringLikeRegexp('AlertTopic') })],
    });
  });

  it('keeps the ETL on a daily schedule and the Parquet target on the curated bucket', () => {
    template.hasResourceProperties('AWS::Events::Rule', { ScheduleExpression: 'cron(0 2 * * ? *)' });
    template.hasResourceProperties('AWS::ECS::TaskDefinition', {
      ContainerDefinitions: Match.arrayWith([Match.objectLike({
        Name: 'EtlContainer',
        Environment: Match.arrayWith([
          Match.objectLike({ Name: 'RAW_LOG_BUCKET' }),
          Match.objectLike({ Name: 'CURATED_BUCKET' }),
        ]),
      })]),
    });
  });
});
