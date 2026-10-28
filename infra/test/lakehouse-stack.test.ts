import { Match, Template } from 'aws-cdk-lib/assertions';
import { loadLakehouseSpecs, icebergFields } from '../lib/lakehouse/spec';
import { cfg, synthApp } from './synth';

// Lakehouse P1 — bronze. Every bronze table's columns come from spec/lakehouse/*.schema.json at
// synth time, so a spec edit that is not reflected here fails this suite rather than drifting.
describe('LakehouseStack (bronze)', () => {
  const { lakehouse } = synthApp();
  const template = Template.fromStack(lakehouse);
  const specs = loadLakehouseSpecs();
  const s3tables = specs.filter((s) => s.lakehouse.storage === 's3tables');

  it('creates one table bucket with bronze, silver and gold namespaces', () => {
    template.hasResourceProperties('AWS::S3Tables::TableBucket', { TableBucketName: `tums-lakehouse-${cfg.env}` });
    for (const ns of ['bronze', 'silver', 'gold']) {
      template.hasResourceProperties('AWS::S3Tables::Namespace', { Namespace: ns });
    }
  });

  it('defines every s3tables bronze table from the spec, columns in spec order, kept forever', () => {
    expect(s3tables.map((s) => s.lakehouse.table).sort()).toEqual(['bedrock_invocations', 'cw_metrics', 'otel_spans']);
    for (const spec of s3tables) {
      template.hasResourceProperties('AWS::S3Tables::Table', {
        TableName: spec.lakehouse.table,
        Namespace: 'bronze',
        OpenTableFormat: 'ICEBERG',
        IcebergMetadata: Match.objectLike({
          IcebergSchema: { SchemaFieldList: icebergFields(spec).map((f) => ({ Name: f.name, Type: f.type, Required: f.required })) },
          IcebergPartitionSpec: { Fields: [Match.objectLike({ Name: spec.lakehouse.partition[0], Transform: 'identity' })] },
        }),
        SnapshotManagement: { Status: 'enabled', MinSnapshotsToKeep: 1, MaxSnapshotAgeHours: 876000 },
      });
    }
  });

  it('maps JSON Schema types to Iceberg types and marks required columns', () => {
    const inv = specs.find((s) => s.lakehouse.table === 'bedrock_invocations')!;
    const fields = icebergFields(inv);
    expect(fields.find((f) => f.name === 'event_ts')).toEqual({ name: 'event_ts', type: 'timestamp', required: true });
    expect(fields.find((f) => f.name === 'raw')).toEqual({ name: 'raw', type: 'string', required: true });
    expect(fields.find((f) => f.name === 'input_body_s3_path')!.required).toBe(false);
    const cw = specs.find((s) => s.lakehouse.table === 'cw_metrics')!;
    expect(icebergFields(cw).find((f) => f.name === 'sum')!.type).toBe('double');
    expect(fields.map((f) => f.name)).toEqual(Object.keys(inv.properties));
  });

  it('runs two Firehose streams into the S3 Tables catalog through the transform Lambda, errors to the errors bucket', () => {
    const streams = template.findResources('AWS::KinesisFirehose::DeliveryStream');
    expect(Object.keys(streams)).toHaveLength(2);
    const catalogArn = `arn:aws:glue:${cfg.region}:${cfg.account}:catalog/s3tablescatalog/tums-lakehouse-${cfg.env}`;
    template.hasResourceProperties('AWS::KinesisFirehose::DeliveryStream', {
      DeliveryStreamName: `tums-lakehouse-${cfg.env}-bedrock`,
      DeliveryStreamType: 'DirectPut',
      IcebergDestinationConfiguration: Match.objectLike({
        CatalogConfiguration: { CatalogArn: catalogArn },
        DestinationTableConfigurationList: Match.arrayWith([
          Match.objectLike({ DestinationDatabaseName: 'bronze', DestinationTableName: 'bedrock_invocations' }),
          Match.objectLike({ DestinationDatabaseName: 'bronze', DestinationTableName: 'otel_spans' }),
        ]),
        ProcessingConfiguration: { Enabled: true, Processors: [
          Match.objectLike({ Type: 'Decompression', Parameters: [{ ParameterName: 'CompressionFormat', ParameterValue: 'GZIP' }] }),
          Match.objectLike({ Type: 'CloudWatchLogProcessing', Parameters: [{ ParameterName: 'DataMessageExtraction', ParameterValue: 'true' }] }),
          Match.objectLike({ Type: 'Lambda' }),
        ] },
        s3BackupMode: 'FailedDataOnly', // CFN spells this one lowercase for the Iceberg destination
        BufferingHints: { IntervalInSeconds: 60, SizeInMBs: 5 },
        S3Configuration: Match.objectLike({ ErrorOutputPrefix: Match.stringLikeRegexp('^errors/') }),
      }),
    });
    template.hasResourceProperties('AWS::KinesisFirehose::DeliveryStream', {
      DeliveryStreamName: `tums-lakehouse-${cfg.env}-metrics`,
      IcebergDestinationConfiguration: Match.objectLike({
        DestinationTableConfigurationList: [Match.objectLike({ DestinationDatabaseName: 'bronze', DestinationTableName: 'cw_metrics' })],
        ProcessingConfiguration: { Enabled: true, Processors: [Match.objectLike({ Type: 'Lambda' })] },
      }),
    });
  });

  it('one transform Lambda per stream, each knowing its stream, the table names and the log groups it routes', () => {
    for (const stream of ['bedrock', 'metrics']) {
      template.hasResourceProperties('AWS::Lambda::Function', {
        Runtime: 'nodejs22.x',
        Environment: {
          Variables: Match.objectLike({
            BRONZE_DATABASE: 'bronze', TABLE_INVOCATIONS: 'bedrock_invocations', TABLE_SPANS: 'otel_spans',
            TABLE_METRICS: 'cw_metrics', SPANS_LOG_GROUP: 'aws/spans', BEDROCK_LOG_GROUP: Match.anyValue(),
            STREAM_NAME: `tums-lakehouse-${cfg.env}-${stream}`,
          }),
        },
      });
    }
    // each may re-ingest overflow rows into its own stream
    const policies = JSON.stringify(template.findResources('AWS::IAM::Policy'));
    expect(policies).toContain('firehose:PutRecordBatch');
  });

  it('subscribes the Bedrock log group and the X-Ray aws/spans group to the bedrock stream', () => {
    template.hasResourceProperties('AWS::Logs::LogGroup', { LogGroupName: `/tums/${cfg.env}/bedrock-invocations`, RetentionInDays: 30 });
    const filters = Object.values(template.findResources('AWS::Logs::SubscriptionFilter')).map((r: any) => r.Properties.LogGroupName);
    expect(filters).toHaveLength(2);
    expect(filters).toContain('aws/spans');
  });

  it('streams only the two Bedrock namespaces, as JSON, into the metrics stream', () => {
    template.hasResourceProperties('AWS::CloudWatch::MetricStream', {
      Name: `tums-lakehouse-${cfg.env}`,
      OutputFormat: 'json',
      IncludeFilters: [{ Namespace: 'AWS/Bedrock' }, { Namespace: 'AWS/BedrockMantle' }],
    });
  });

  it('does not create a Transaction Search config unless the env opts in (dev already has it)', () => {
    template.resourceCountIs('AWS::XRay::TransactionSearchConfig', 0);
  });

  it('exports CUR 2.0 daily with resource ids, selecting exactly the cur_raw spec columns', () => {
    const cur = specs.find((s) => s.lakehouse.table === 'cur_raw')!;
    const cols = Object.keys(cur.properties).filter((c) => c !== 'billing_period');
    template.hasResourceProperties('AWS::BCMDataExports::Export', {
      Export: Match.objectLike({
        Name: `tums-cur2-${cfg.env}`,
        DataQuery: {
          QueryStatement: `SELECT ${cols.join(', ')} FROM COST_AND_USAGE_REPORT`,
          TableConfigurations: { COST_AND_USAGE_REPORT: Match.objectLike({ TIME_GRANULARITY: 'DAILY', INCLUDE_RESOURCES: 'TRUE' }) },
        },
        DestinationConfigurations: { S3Destination: Match.objectLike({ S3Prefix: 'cur2', S3OutputConfigurations: Match.objectLike({ Format: 'PARQUET', Overwrite: 'OVERWRITE_REPORT' }) }) },
        RefreshCadence: { Frequency: 'SYNCHRONOUS' },
      }),
    });
    template.hasResourceProperties('AWS::Glue::Table', {
      DatabaseName: `token_monitoring_${cfg.env}`,
      TableInput: Match.objectLike({
        Name: 'cur_raw',
        PartitionKeys: [{ Name: 'billing_period', Type: 'string' }],
        Parameters: Match.objectLike({ 'projection.enabled': 'true', 'projection.billing_period.type': 'date', 'projection.billing_period.format': 'yyyy-MM' }),
        StorageDescriptor: Match.objectLike({ Columns: cols.map((c) => Match.objectLike({ Name: c })) }),
      }),
    });
  });

  it('grants the Firehose role and the owner principal on the bronze tables through Lake Formation', () => {
    const perms = Object.values(template.findResources('AWS::LakeFormation::PrincipalPermissions')).map((r: any) => r.Properties);
    const owner = perms.filter((p) => p.Principal.DataLakePrincipalIdentifier === cfg.lakehouse!.ownerPrincipalArn);
    expect(owner.filter((p) => p.Resource.Table).length).toBe(3);
    for (const p of owner.filter((p) => p.Resource.Table)) expect(p.Permissions).toEqual(expect.arrayContaining(['SELECT']));
    expect(owner.find((p) => p.Resource.Database)!.Permissions).toEqual(['DESCRIBE']);
    const firehose = perms.filter((p) => JSON.stringify(p.Principal).includes('FirehoseRole'));
    expect(firehose.length).toBeGreaterThanOrEqual(3);
    for (const p of perms) {
      expect(JSON.stringify(p.Resource)).toContain(`s3tablescatalog/tums-lakehouse-${cfg.env}`);
    }
  });

  it('alarms on Firehose delivery failures, throttling and transform errors, routed to the governance topic', () => {
    const alarms = Object.values(template.findResources('AWS::CloudWatch::Alarm')).map((r: any) => r.Properties);
    expect(alarms.filter((a) => a.MetricName === 'DeliveryToIceberg.Success')).toHaveLength(2);
    expect(alarms.filter((a) => a.MetricName === 'ThrottledRecords')).toHaveLength(2);
    expect(alarms.filter((a) => a.MetricName === 'Errors' && a.Namespace === 'AWS/Lambda')).toHaveLength(2);
    for (const a of alarms) expect(JSON.stringify(a.AlarmActions)).toMatch(/AlertTopic/);
  });

  it('keeps the request/response bodies, Firehose errors and CUR exports in dedicated KMS buckets', () => {
    for (const name of ['bodies', 'errors', 'cur']) {
      template.hasResourceProperties('AWS::S3::Bucket', {
        BucketName: `tums-lakehouse-${name}-${cfg.env}-${cfg.account}`,
        PublicAccessBlockConfiguration: Match.objectLike({ BlockPublicAcls: true }),
      });
    }
  });

  it('lets both Data Exports principals write the CUR bucket and creates the export after the policy (deploy 2026-10-27)', () => {
    template.hasResourceProperties('AWS::S3::BucketPolicy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([Match.objectLike({
          Sid: 'AllowDataExportsWrite',
          Principal: { Service: Match.arrayWith(['billingreports.amazonaws.com', 'bcm-data-exports.amazonaws.com']) },
          Condition: Match.objectLike({ StringLike: { 'aws:SourceArn': Match.arrayWith([Match.stringLikeRegexp('^arn:aws:cur:us-east-1:.*:definition/\\*$'), Match.stringLikeRegexp('^arn:aws:bcm-data-exports:us-east-1:.*:export/\\*$')]) } }),
        })]),
      }),
    });
    const exports = template.findResources('AWS::BCMDataExports::Export');
    const dep = (Object.values(exports)[0] as any).DependsOn as string[];
    expect(dep.some((d) => /CurBucketPolicy/.test(d))).toBe(true);
    template.hasResourceProperties('AWS::S3::Bucket', Match.objectLike({
      BucketName: Match.stringLikeRegexp('^tums-lakehouse-cur-'),
      BucketEncryption: { ServerSideEncryptionConfiguration: [{ ServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } }] },
    }));
  });

  it('creates the Glue zero-ETL mirrors only when lakehouse.enableZeroEtl is true (default off after the 2026-10-28 deploy)', () => {
    template.resourceCountIs('AWS::Glue::Integration', 0);
    template.resourceCountIs('AWS::Glue::IntegrationResourceProperty', 0);
    const { lakehouse: withZeroEtl } = synthApp({ ...cfg, lakehouse: { ...cfg.lakehouse!, enableZeroEtl: true } });
    Template.fromStack(withZeroEtl).resourceCountIs('AWS::Glue::Integration', 2);
  });
});
