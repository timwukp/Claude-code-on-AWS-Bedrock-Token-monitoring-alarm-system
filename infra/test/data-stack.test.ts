import { Match, Template } from 'aws-cdk-lib/assertions';
import { cfg, synthApp } from './synth';

// The Full view used to query a Glue table whose LOCATION was Bedrock's own delivery prefix, so the
// >100 KB body objects under `data/` were scanned too (40 GB of 41.7 GB) and one OpenAI Responses body
// broke every query (qa F-PR75-001). The curated table below is what the API queries from P0 on.
describe('DataStack curated invocation table', () => {
  const { data } = synthApp();
  const template = Template.fromStack(data);

  it('defines bedrock_invocations_curated as Parquet over the ETL output, in code not by hand', () => {
    template.hasResourceProperties('AWS::Glue::Table', {
      DatabaseName: `token_monitoring_${cfg.env}`,
      TableInput: Match.objectLike({
        Name: 'bedrock_invocations_curated',
        TableType: 'EXTERNAL_TABLE',
        PartitionKeys: [{ Name: 'dt', Type: 'string' }],
        StorageDescriptor: Match.objectLike({
          Location: Match.objectLike({ 'Fn::Join': Match.arrayWith([Match.arrayWith([Match.stringLikeRegexp('/usage/$')])]) }),
          InputFormat: 'org.apache.hadoop.hive.ql.io.parquet.MapredParquetInputFormat',
          SerdeInfo: Match.objectLike({ SerializationLibrary: 'org.apache.hadoop.hive.ql.io.parquet.serde.ParquetHiveSerDe' }),
          Columns: Match.arrayWith([
            { Name: 'timestamp', Type: 'string' },
            { Name: 'requestId', Type: 'string' },
            { Name: 'modelId', Type: 'string' },
            { Name: 'identityArn', Type: 'string' },
            { Name: 'requestMetadata', Type: 'string' },
            { Name: 'inputTokenCount', Type: 'bigint' },
            { Name: 'cacheReadInputTokenCount', Type: 'bigint' },
            { Name: 'cacheWriteInputTokenCount', Type: 'bigint' },
            { Name: 'outputTokenCount', Type: 'bigint' },
          ]),
        }),
      }),
    });
  });

  it('prunes by dt through partition projection so no partition registration is ever needed', () => {
    template.hasResourceProperties('AWS::Glue::Table', {
      TableInput: Match.objectLike({
        Name: 'bedrock_invocations_curated',
        Parameters: Match.objectLike({
          'projection.enabled': 'true',
          'projection.dt.type': 'date',
          'projection.dt.format': 'yyyy-MM-dd',
          'projection.dt.range': Match.stringLikeRegexp('^2026-06-01,NOW$'),
          'storage.location.template': Match.objectLike({ 'Fn::Join': Match.arrayWith([Match.arrayWith([Match.stringLikeRegexp('/usage/dt=\\$\\{dt\\}/$')])]) }),
          'parquet.compression': 'SNAPPY',
        }),
      }),
    });
  });

  it('never defines a table over the raw delivery prefix (bodies live there)', () => {
    const tables = template.findResources('AWS::Glue::Table');
    for (const t of Object.values(tables)) {
      const loc = JSON.stringify((t as any).Properties.TableInput.StorageDescriptor.Location);
      expect(loc).not.toMatch(/RawLogBucket|model-logs/);
    }
  });
});
