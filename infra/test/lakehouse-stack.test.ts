import { Match, Template } from 'aws-cdk-lib/assertions';
import { loadLakehouseSpecs, icebergFields } from '../lib/lakehouse/spec';
import { cfg, synthApp } from './synth';

// Lakehouse P1 — bronze. Every bronze table's columns come from spec/lakehouse/*.schema.json at
// synth time, so a spec edit that is not reflected here fails this suite rather than drifting.
describe('LakehouseStack (bronze)', () => {
  const { lakehouse } = synthApp();
  const template = Template.fromStack(lakehouse);
  const specs = loadLakehouseSpecs();
  const s3tables = specs.filter((s) => s.lakehouse.storage === 's3tables' && s.lakehouse.layer === 'bronze');

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
        // Iceberg destinations accept the Lambda processor only (Decompression / CloudWatchLogProcessing are
        // S3/Splunk/Snowflake-only — dev deploy 2026-10-28); the Lambda unpacks the CloudWatch Logs envelope.
        ProcessingConfiguration: { Enabled: true, Processors: [Match.objectLike({ Type: 'Lambda' })] },
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
    const owner = perms.filter((p) => p.Principal.DataLakePrincipalIdentifier === cfg.lakehouse!.ownerPrincipalArn && JSON.stringify(p.Resource).includes('"bronze"'));
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
    expect(alarms.filter((a) => a.MetricName === 'Errors' && a.Namespace === 'AWS/Lambda')).toHaveLength(5); // 2 transforms + dim_model + registry + quality gate
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

  it('lets the Firehose role resolve the table through every level of the S3 Tables federated catalog', () => {
    const policies = template.findResources('AWS::IAM::Policy');
    const glueStmts = Object.values(policies).flatMap((p: any) => p.Properties.PolicyDocument.Statement)
      .filter((st: any) => JSON.stringify(st.Action).includes('glue:GetTable'));
    const res = JSON.stringify(glueStmts.map((st: any) => st.Resource));
    expect(res).toContain(':catalog/s3tablescatalog"');
    expect(res).toMatch(/catalog\/s3tablescatalog\/tums-lakehouse-ci/);
    expect(res).toMatch(/table\/s3tablescatalog\/tums-lakehouse-ci\/\*\/\*/);
    expect(JSON.stringify(glueStmts.map((st: any) => st.Action))).toContain('glue:GetCatalog');
  });

  it('gives the Logs→Firehose and Metric Stream roles their PutRecord permission inline, so the filters cannot race the policy', () => {
    const roles = template.findResources('AWS::IAM::Role');
    const inline = Object.values(roles).filter((r: any) => JSON.stringify(r.Properties.Policies ?? []).includes('firehose:PutRecord'));
    expect(inline.length).toBe(2);
    const subs = template.findResources('AWS::Logs::SubscriptionFilter');
    expect(Object.keys(subs)).toHaveLength(2);
    for (const sub of Object.values(subs)) expect(((sub as any).DependsOn as string[]).some((d) => /LogsToFirehoseRole/.test(d))).toBe(true);
  });
});

// Lakehouse P2 — silver. Same spec-first rule: six silver tables from spec/lakehouse/silver.*.schema.json,
// written by the transform (invocations, adapter_audit) and by hourly Athena jobs (the rest).
describe('LakehouseStack (silver)', () => {
  const { lakehouse } = synthApp();
  const template = Template.fromStack(lakehouse);
  const specs = loadLakehouseSpecs();
  const silver = specs.filter((s) => s.lakehouse.layer === 'silver');
  const perms = () => Object.values(template.findResources('AWS::LakeFormation::PrincipalPermissions')).map((r: any) => r.Properties);

  it('defines every silver table from the spec in the silver namespace; 90-day retention becomes 2160 h', () => {
    expect(silver.map((s) => s.lakehouse.table).sort()).toEqual(['adapter_audit', 'bedrock_metrics_hourly', 'bill_daily', 'dim_model', 'invocations', 'project_registry']);
    for (const spec of silver) {
      const hours = spec.lakehouse.retention === '90d' ? 2160 : 876000;
      template.hasResourceProperties('AWS::S3Tables::Table', {
        TableName: spec.lakehouse.table,
        Namespace: 'silver',
        IcebergMetadata: Match.objectLike({
          IcebergSchema: { SchemaFieldList: icebergFields(spec).map((f) => ({ Name: f.name, Type: f.type, Required: f.required })) },
        }),
        SnapshotManagement: { Status: 'enabled', MinSnapshotsToKeep: 1, MaxSnapshotAgeHours: hours },
      });
    }
    template.resourceCountIs('AWS::S3Tables::Table', 9);
  });

  it('routes silver.invocations and silver.adapter_audit through the bedrock Firehose stream and tells the transforms about them', () => {
    template.hasResourceProperties('AWS::KinesisFirehose::DeliveryStream', {
      DeliveryStreamName: `tums-lakehouse-${cfg.env}-bedrock`,
      IcebergDestinationConfiguration: Match.objectLike({
        DestinationTableConfigurationList: Match.arrayWith([
          Match.objectLike({ DestinationDatabaseName: 'silver', DestinationTableName: 'invocations' }),
          Match.objectLike({ DestinationDatabaseName: 'silver', DestinationTableName: 'adapter_audit' }),
        ]),
      }),
    });
    const fns = Object.values(template.findResources('AWS::Lambda::Function')).map((f: any) => f.Properties.Environment?.Variables ?? {});
    const transforms = fns.filter((v) => v.TABLE_INVOCATIONS === 'bedrock_invocations');
    expect(transforms).toHaveLength(2);
    for (const v of transforms) {
      expect(v.SILVER_DATABASE).toBe('silver');
      expect(v.TABLE_SILVER_INVOCATIONS).toBe('invocations');
      expect(v.TABLE_ADAPTER_AUDIT).toBe('adapter_audit');
      expect(v.TENANTS_TABLE).toBeDefined();
    }
  });

  it('grants: Firehose ALL on silver.invocations + adapter_audit; owner SELECT on every silver table; the jobs and state-machine roles get ALL silver / SELECT bronze / DESCRIBE both', () => {
    const p = perms();
    const silverTbl = (x: any) => x.Resource.Table && x.Resource.Table.DatabaseName === 'silver';
    const firehose = p.filter((x) => JSON.stringify(x.Principal).includes('FirehoseRole') && silverTbl(x));
    expect(firehose.map((x) => x.Resource.Table.Name).sort()).toEqual(['adapter_audit', 'invocations']);
    for (const x of firehose) expect(x.Permissions).toEqual(['ALL']);
    const owner = p.filter((x) => x.Principal.DataLakePrincipalIdentifier === cfg.lakehouse!.ownerPrincipalArn && silverTbl(x));
    expect(owner.length).toBe(6);
    for (const tag of ['SilverJobsRole', 'SilverSfnRole']) {
      const jobs = p.filter((x) => JSON.stringify(x.Principal).includes(tag));
      expect(jobs.filter(silverTbl).length).toBe(6);
      for (const x of jobs.filter(silverTbl)) expect(x.Permissions).toEqual(['ALL']);
      const jobsBronze = jobs.filter((x) => x.Resource.Table && x.Resource.Table.DatabaseName === 'bronze');
      expect(jobsBronze.length).toBe(3);
      for (const x of jobsBronze) expect(x.Permissions).toEqual(expect.arrayContaining(['SELECT']));
      expect(jobs.filter((x) => x.Resource.Database).map((x) => x.Resource.Database.Name).sort()).toEqual(['bronze', 'silver']);
    }
    // Lambdas and the state machine use separate roles (a shared one is a CloudFormation cycle); both are granted above.
    const roles = template.findResources('AWS::IAM::Role');
    const trust = (re: RegExp) => JSON.stringify((Object.entries(roles).find(([id]) => re.test(id))![1] as any).Properties.AssumeRolePolicyDocument);
    expect(trust(/SilverJobsRole/)).toContain('lambda.amazonaws.com');
    expect(trust(/SilverSfnRole/)).toContain('states.amazonaws.com');
  });

  it('refreshes dim_model daily and snapshots the registry hourly from Lambdas that may list Bedrock models and query Athena', () => {
    template.hasResourceProperties('AWS::Events::Rule', { ScheduleExpression: 'cron(0 5 * * ? *)' });
    template.hasResourceProperties('AWS::Events::Rule', { ScheduleExpression: 'cron(5 * * * ? *)' });
    const fns = Object.values(template.findResources('AWS::Lambda::Function')).map((f: any) => f.Properties);
    const dim = fns.find((f) => f.Environment?.Variables?.CATALOG && f.Environment?.Variables?.TABLE_BUCKET && !f.Environment?.Variables?.TENANTS_TABLE);
    expect(dim).toBeDefined();
    expect(dim!.Environment.Variables.CATALOG).toBe(`s3tablescatalog/tums-lakehouse-${cfg.env}`);
    expect(dim!.Environment.Variables.ATHENA_WORKGROUP).toBeDefined();
    expect(dim!.Runtime).toBe('nodejs22.x');
    const policies = JSON.stringify(Object.values(template.findResources('AWS::IAM::Policy')).map((p: any) => p.Properties.PolicyDocument.Statement));
    for (const a of ['bedrock:ListFoundationModels', 'bedrock:ListInferenceProfiles', 'bedrock:ListProvisionedModelThroughputs', 'bedrock:ListCustomModels', 'bedrock:ListImportedModels', 'pricing:GetProducts', 'athena:StartQueryExecution', 'lakeformation:GetDataAccess']) {
      expect(policies).toContain(a);
    }
    const reg = fns.find((f) => f.Environment?.Variables?.TENANTS_TABLE && f.Environment?.Variables?.CATALOG);
    expect(reg).toBeDefined();
  });

  it('runs the silver SQL hourly as Athena tasks in a state machine, with a quality gate Lambda, and alarms on failure', () => {
    template.hasResourceProperties('AWS::Events::Rule', { ScheduleExpression: 'cron(15 * * * ? *)' });
    const sms = Object.values(template.findResources('AWS::StepFunctions::StateMachine'));
    expect(sms).toHaveLength(1);
    const alarms = Object.values(template.findResources('AWS::CloudWatch::Alarm')).map((r: any) => r.Properties);
    expect(alarms.filter((a) => a.Namespace === 'AWS/States' && a.MetricName === 'ExecutionsFailed')).toHaveLength(1);
    const fns = Object.values(template.findResources('AWS::Lambda::Function')).map((f: any) => f.Properties);
    expect(fns.some((f) => f.Environment?.Variables?.QUALITY_GATE === 'true')).toBe(true);
  });

  it('builds one Athena task per silver_*.sql then quality_*.sql when the sql directory has files, substituting the catalog placeholders', () => {
    const fs = require('fs') as typeof import('fs');
    const os = require('os') as typeof import('os');
    const path = require('path') as typeof import('path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lh-sql-'));
    fs.writeFileSync(path.join(dir, 'silver_10_invocations.sql'), 'MERGE INTO ${CATALOG}.silver.invocations t USING ${CATALOG}.bronze.bedrock_invocations b ON t.request_id = b.request_id WHEN NOT MATCHED THEN INSERT *');
    fs.writeFileSync(path.join(dir, 'silver_20_bill.sql'), 'INSERT INTO ${CATALOG}.silver.bill_daily SELECT * FROM ${GLUE_DB}.cur_raw');
    fs.writeFileSync(path.join(dir, 'quality_10_nulls.sql'), 'SELECT count(*) FROM ${CATALOG}.silver.invocations WHERE model_key IS NULL HAVING count(*) > 0');
    const { lakehouse: withSql } = synthApp(cfg, { sqlDir: dir });
    const sm: any = Object.values(Template.fromStack(withSql).findResources('AWS::StepFunctions::StateMachine'))[0];
    const def = JSON.stringify(sm.Properties.DefinitionString);
    expect(def).toContain('athena:startQueryExecution.sync');
    expect(def.replace(/\\+/g, '')).toContain(`"s3tablescatalog/tums-lakehouse-${cfg.env}".silver.invocations`);
    expect(def).toContain(`token_monitoring_${cfg.env}.cur_raw`);
    expect(def).not.toContain('${CATALOG}');
    expect(def.indexOf('silver_10_invocations')).toBeLessThan(def.indexOf('silver_20_bill'));
    expect(def.indexOf('silver_20_bill')).toBeLessThan(def.indexOf('quality_10_nulls'));
    expect(def).toContain('lambda:invoke'); // the quality gate follows each quality query
  });

  it('registers silver with the SMUS project only when lakehouse.enableSmusPublish is set', () => {
    template.resourceCountIs('AWS::DataZone::DataSource', 0);
    const { lakehouse: published } = synthApp({ ...cfg, lakehouse: { ...cfg.lakehouse!, enableSmusPublish: true } });
    const t2 = Template.fromStack(published);
    t2.resourceCountIs('AWS::DataZone::DataSource', 1);
    t2.hasResourceProperties('AWS::DataZone::DataSource', {
      Type: 'GLUE',
      DomainIdentifier: cfg.lakehouse!.smusDomainId,
      ProjectIdentifier: cfg.lakehouse!.smusProjectId,
      PublishOnImport: true,
      Configuration: Match.objectLike({ GlueRunConfiguration: Match.objectLike({ RelationalFilterConfigurations: [Match.objectLike({ DatabaseName: 'silver' })] }) }),
    });
  });

  it('gives the Bedrock logs role a well-formed log-stream resource (no `:*` from the log group ARN)', () => {
    const policies = Object.values(template.findResources('AWS::IAM::Policy')).map((p: any) => JSON.stringify(p.Properties.PolicyDocument.Statement));
    const stmt = policies.find((s) => s.includes('aws/bedrock/modelinvocations'))!;
    expect(stmt).toBeDefined();
    expect(stmt).not.toContain(':*:log-stream');
    expect(stmt).not.toContain(':*\",\":log-stream');
  });

  it('runs lakehouse Athena jobs in a dedicated workgroup with NO explicit result encryption (writes to a KMS S3 Tables bucket fail otherwise)', () => {
    template.hasResourceProperties('AWS::Athena::WorkGroup', {
      Name: `tums-lakehouse-${cfg.env}`,
      WorkGroupConfiguration: Match.objectLike({
        EnforceWorkGroupConfiguration: true,
        BytesScannedCutoffPerQuery: 50 * 1024 * 1024 * 1024,
        ResultConfiguration: Match.objectLike({ OutputLocation: Match.anyValue() }),
      }),
    });
    const wg = Object.values(template.findResources('AWS::Athena::WorkGroup')).find((w: any) => w.Properties.Name === `tums-lakehouse-${cfg.env}`) as any;
    expect(wg.Properties.WorkGroupConfiguration.ResultConfiguration.EncryptionConfiguration).toBeUndefined();
    const sm = Object.values(template.findResources('AWS::StepFunctions::StateMachine'))[0] as any;
    expect(JSON.stringify(sm.Properties.DefinitionString)).toContain(`tums-lakehouse-${cfg.env}`);
    expect(JSON.stringify(sm.Properties.DefinitionString)).not.toContain(`token-monitoring-${cfg.env}`);
    const fns = template.findResources('AWS::Lambda::Function');
    const envs = Object.values(fns).map((f: any) => JSON.stringify(f.Properties.Environment ?? {}));
    expect(envs.filter((e) => e.includes('ATHENA_WORKGROUP')).every((e) => e.includes(`tums-lakehouse-${cfg.env}`))).toBe(true);
  });
});
