import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3tables from 'aws-cdk-lib/aws-s3tables';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as firehose from 'aws-cdk-lib/aws-kinesisfirehose';
import * as cw from 'aws-cdk-lib/aws-cloudwatch';
import * as cwActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as glue from 'aws-cdk-lib/aws-glue';
import * as lakeformation from 'aws-cdk-lib/aws-lakeformation';
import * as bcm from 'aws-cdk-lib/aws-bcmdataexports';
import * as xray from 'aws-cdk-lib/aws-xray';
import { Construct } from 'constructs';
import { EnvConfig } from '../config';
import { DataTables } from './data-stack';
import { BACKEND_ROOT, BACKEND_LOCK, lambdaEntry } from './paths';
import { glueType, icebergFields, loadLakehouseSpecs } from '../lakehouse/spec';

interface Props extends cdk.StackProps {
  cfg: EnvConfig;
  dataKey: kms.Key;
  tables: DataTables;
  alertTopic: sns.ITopic;
  curatedBucket: s3.Bucket;
}

/**
 * Lakehouse P1 — the bronze layer and everything that feeds it.
 *
 *   Bedrock invocation log ─ CloudWatch Logs destination ─┐
 *   X-Ray Transaction Search (aws/spans, OTel GenAI)   ─┼─► Firehose (bedrock) ─ transform Lambda ─► S3 Tables bronze.{bedrock_invocations, otel_spans}
 *   CloudWatch Metric Streams (AWS/Bedrock*)           ───► Firehose (metrics) ─ transform Lambda ─► S3 Tables bronze.cw_metrics
 *   AWS Data Exports CUR 2.0 ─► cur bucket ─► Glue external table bronze cur_raw
 *   DynamoDB (dora, registry) ─ Glue zero-ETL ─► Glue database (Iceberg under curated/zero-etl/)
 *
 * Bodies > 100 KB go to a dedicated bucket — never under a table prefix again (qa F-PR75-001).
 * Bronze is kept forever (owner decision 2026-10-24) and is readable only by the pipeline roles and
 * the owner principal; it holds prompt text. Table columns come from spec/lakehouse at synth time.
 */
export class LakehouseStack extends cdk.Stack {
  public readonly bedrockLogGroup: logs.LogGroup;
  public readonly bedrockLogsRole: iam.Role;
  public readonly bodiesBucket: s3.Bucket;
  public readonly tableBucketArn: string;

  constructor(scope: Construct, id: string, props: Props) {
    super(scope, id, props);
    const { cfg, dataKey, tables, alertTopic, curatedBucket } = props;
    const lh = cfg.lakehouse ?? { smusDomainId: '', smusProjectId: '', ownerPrincipalArn: '' };
    const specs = loadLakehouseSpecs();
    const tableBucketName = `tums-lakehouse-${cfg.env}`;
    const catalogArn = `arn:aws:glue:${cfg.region}:${cfg.account}:catalog/s3tablescatalog/${tableBucketName}`;
    // Lake Formation addresses S3 Tables through the federated catalog `<account>:s3tablescatalog/<bucket>`.
    const lfCatalogId = `${cfg.account}:s3tablescatalog/${tableBucketName}`;

    // --- General-purpose buckets ---------------------------------------------------------------
    const secureBucket = (idName: string, name: string, expireDays?: number) =>
      new s3.Bucket(this, idName, {
        bucketName: name,
        encryption: s3.BucketEncryption.KMS,
        encryptionKey: dataKey,
        enforceSSL: true,
        blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
        versioned: true,
        lifecycleRules: expireDays ? [{ expiration: cdk.Duration.days(expireDays), transitions: [] }] : undefined,
        removalPolicy: cdk.RemovalPolicy.RETAIN,
      });
    this.bodiesBucket = secureBucket('BodiesBucket', `tums-lakehouse-bodies-${cfg.env}-${cfg.account}`);
    const errorsBucket = secureBucket('ErrorsBucket', `tums-lakehouse-errors-${cfg.env}-${cfg.account}`, 90);
    // SSE-S3, not KMS: Data Exports validates that its service principals can write to the bucket at
    // export-creation time and does not use a customer key; billing lines carry no prompt text.
    const curBucket = new s3.Bucket(this, 'CurBucket', {
      bucketName: `tums-lakehouse-cur-${cfg.env}-${cfg.account}`,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      versioned: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // Bedrock writes the > 100 KB request/response bodies here (same policy shape as the raw-log bucket).
    this.bodiesBucket.addToResourcePolicy(new iam.PolicyStatement({
      sid: 'AmazonBedrockLargeBodiesWrite',
      principals: [new iam.ServicePrincipal('bedrock.amazonaws.com')],
      actions: ['s3:PutObject'],
      resources: [this.bodiesBucket.arnForObjects('bodies/*')],
      conditions: {
        StringEquals: { 'aws:SourceAccount': cfg.account },
        ArnLike: { 'aws:SourceArn': `arn:aws:bedrock:${cfg.region}:${cfg.account}:*` },
      },
    }));
    // AWS Data Exports delivers CUR 2.0 here.
    // Both service principals must be allowed, and each validates with its own SourceArn shape
    // (cur:…:definition/* for billingreports, bcm-data-exports:…:export/*). Deploy 2026-10-27 failed
    // with "S3 bucket permission validation failed" when only the latter was listed.
    curBucket.addToResourcePolicy(new iam.PolicyStatement({
      sid: 'AllowDataExportsWrite',
      principals: [new iam.ServicePrincipal('billingreports.amazonaws.com'), new iam.ServicePrincipal('bcm-data-exports.amazonaws.com')],
      actions: ['s3:PutObject', 's3:GetBucketPolicy'],
      resources: [curBucket.bucketArn, curBucket.arnForObjects('*')],
      conditions: {
        StringEquals: { 'aws:SourceAccount': cfg.account },
        StringLike: { 'aws:SourceArn': [`arn:aws:cur:us-east-1:${cfg.account}:definition/*`, `arn:aws:bcm-data-exports:us-east-1:${cfg.account}:export/*`] },
      },
    }));

    // --- S3 Tables: table bucket, namespaces, bronze tables from the spec ----------------------
    const tableBucket = new s3tables.CfnTableBucket(this, 'TableBucket', {
      tableBucketName,
      encryptionConfiguration: { sseAlgorithm: 'aws:kms', kmsKeyArn: dataKey.keyArn },
      unreferencedFileRemoval: { status: 'Enabled', noncurrentDays: 10, unreferencedDays: 3 },
    });
    this.tableBucketArn = tableBucket.attrTableBucketArn;
    const namespaces: Record<string, s3tables.CfnNamespace> = {};
    for (const ns of ['bronze', 'silver', 'gold']) {
      namespaces[ns] = new s3tables.CfnNamespace(this, `Namespace${ns[0].toUpperCase()}${ns.slice(1)}`, {
        namespace: ns, tableBucketArn: tableBucket.attrTableBucketArn,
      });
    }
    // S3 Tables encrypts with the table bucket's KMS key; the maintenance service principal must be able to use it.
    dataKey.addToResourcePolicy(new iam.PolicyStatement({
      sid: 'AllowS3TablesMaintenance',
      principals: [new iam.ServicePrincipal('maintenance.s3tables.amazonaws.com')],
      actions: ['kms:GenerateDataKey', 'kms:Decrypt'],
      resources: ['*'],
      conditions: { StringEquals: { 'aws:SourceAccount': cfg.account } },
    }));

    const bronzeTables: Record<string, s3tables.CfnTable> = {};
    for (const spec of specs.filter((s) => s.lakehouse.storage === 's3tables')) {
      const fields = icebergFields(spec);
      const partitionCol = spec.lakehouse.partition[0];
      const sourceId = fields.findIndex((f) => f.name === partitionCol) + 1; // Iceberg field ids are 1-based, in schema order
      const t = new s3tables.CfnTable(this, `Bronze${spec.lakehouse.table.split('_').map((w) => w[0].toUpperCase() + w.slice(1)).join('')}`, {
        tableBucketArn: tableBucket.attrTableBucketArn,
        namespace: 'bronze',
        tableName: spec.lakehouse.table,
        openTableFormat: 'ICEBERG',
        icebergMetadata: {
          icebergSchema: { schemaFieldList: fields.map((f, i) => ({ id: i + 1, name: f.name, type: f.type, required: f.required })) },
          icebergPartitionSpec: { fields: [{ name: partitionCol, sourceId, transform: 'identity', fieldId: 1000 }] },
        },
        compaction: { status: 'enabled', targetFileSizeMb: 128 },
        // Bronze is the permanent copy: 100 years, i.e. never expire snapshots by age.
        snapshotManagement: { status: 'enabled', minSnapshotsToKeep: 1, maxSnapshotAgeHours: 876000 },
      });
      t.addDependency(namespaces.bronze);
      bronzeTables[spec.lakehouse.table] = t;
    }

    // --- CloudWatch Logs destination for Bedrock invocation logging ----------------------------
    this.bedrockLogGroup = new logs.LogGroup(this, 'BedrockInvocationLogs', {
      logGroupName: `/tums/${cfg.env}/bedrock-invocations`,
      retention: logs.RetentionDays.ONE_MONTH, // bronze keeps the permanent copy
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    this.bedrockLogsRole = new iam.Role(this, 'BedrockLogsRole', {
      assumedBy: new iam.ServicePrincipal('bedrock.amazonaws.com', {
        conditions: {
          StringEquals: { 'aws:SourceAccount': cfg.account },
          ArnLike: { 'aws:SourceArn': `arn:aws:bedrock:${cfg.region}:${cfg.account}:*` },
        },
      }),
    });
    this.bedrockLogsRole.addToPolicy(new iam.PolicyStatement({
      actions: ['logs:CreateLogStream', 'logs:PutLogEvents'],
      resources: [`${this.bedrockLogGroup.logGroupArn}:log-stream:aws/bedrock/modelinvocations`],
    }));

    // --- Transform Lambdas (Firehose processors): envelope → typed bronze rows + routing ---------
    // One function per stream: the Lambda re-ingests overflow rows into its own stream, so it needs
    // the stream name in its environment (set here from the literal name to avoid a dependency cycle).
    const streamArn = (name: string) => `arn:aws:firehose:${cfg.region}:${cfg.account}:deliverystream/${name}`;
    const transform = (idName: string, streamName: string) => {
      const fn = new NodejsFunction(this, idName, {
        runtime: lambda.Runtime.NODEJS_22_X,
        entry: lambdaEntry('lakehouse', 'transform.ts'),
        projectRoot: BACKEND_ROOT,
        depsLockFilePath: BACKEND_LOCK,
        handler: 'handler',
        timeout: cdk.Duration.minutes(1),
        memorySize: 1024,
        tracing: lambda.Tracing.ACTIVE,
        environment: {
          BRONZE_DATABASE: 'bronze',
          TABLE_INVOCATIONS: 'bedrock_invocations',
          TABLE_SPANS: 'otel_spans',
          TABLE_METRICS: 'cw_metrics',
          STREAM_NAME: streamName,
          BEDROCK_LOG_GROUP: this.bedrockLogGroup.logGroupName,
          SPANS_LOG_GROUP: 'aws/spans',
          TENANTS_TABLE: tables.tenants.tableName,
        },
      });
      tables.tenants.grantReadData(fn);
      fn.addToRolePolicy(new iam.PolicyStatement({ actions: ['firehose:PutRecordBatch'], resources: [streamArn(streamName)] }));
      return fn;
    };
    const bedrockStreamName = `${tableBucketName}-bedrock`;
    const metricsStreamName = `${tableBucketName}-metrics`;
    const bedrockTransformFn = transform('LakehouseTransformFn', bedrockStreamName);
    const metricsTransformFn = transform('LakehouseMetricsTransformFn', metricsStreamName);

    // --- Firehose → S3 Tables (Iceberg) ---------------------------------------------------------
    const firehoseRole = new iam.Role(this, 'FirehoseRole', { assumedBy: new iam.ServicePrincipal('firehose.amazonaws.com') });
    errorsBucket.grantReadWrite(firehoseRole);
    dataKey.grantEncryptDecrypt(firehoseRole);
    bedrockTransformFn.grantInvoke(firehoseRole);
    metricsTransformFn.grantInvoke(firehoseRole);
    firehoseRole.addToPolicy(new iam.PolicyStatement({
      actions: ['glue:GetTable', 'glue:GetTables', 'glue:GetDatabase', 'glue:GetDatabases', 'glue:UpdateTable', 'glue:GetCatalog', 'glue:GetCatalogs'],
      // The S3 Tables federated catalog is addressed at three levels (root catalog, `s3tablescatalog`,
      // `s3tablescatalog/<bucket>`); Firehose resolves the table through all of them.
      resources: [
        `arn:aws:glue:${cfg.region}:${cfg.account}:catalog`,
        `arn:aws:glue:${cfg.region}:${cfg.account}:catalog/s3tablescatalog`,
        catalogArn,
        `${catalogArn}/*`,
        `arn:aws:glue:${cfg.region}:${cfg.account}:database/s3tablescatalog/${tableBucketName}/*`,
        `arn:aws:glue:${cfg.region}:${cfg.account}:table/s3tablescatalog/${tableBucketName}/*/*`,
      ],
    }));
    firehoseRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        's3tables:GetTableBucket', 's3tables:GetNamespace', 's3tables:ListTables', 's3tables:GetTable',
        's3tables:GetTableMetadataLocation', 's3tables:UpdateTableMetadataLocation', 's3tables:GetTableData', 's3tables:PutTableData',
      ],
      resources: [tableBucket.attrTableBucketArn, `${tableBucket.attrTableBucketArn}/*`],
    }));
    firehoseRole.addToPolicy(new iam.PolicyStatement({ actions: ['lakeformation:GetDataAccess'], resources: ['*'] }));
    const firehoseLogGroup = new logs.LogGroup(this, 'FirehoseLogs', { retention: logs.RetentionDays.ONE_MONTH, removalPolicy: cdk.RemovalPolicy.DESTROY });
    firehoseLogGroup.grantWrite(firehoseRole);

    // Lake Formation: the Firehose role writes bronze; the owner may read it; nobody else.
    const lfGrants: lakeformation.CfnPrincipalPermissions[] = [];
    const grant = (idName: string, principal: string, table: string | null, permissions: string[]) => {
      const p = new lakeformation.CfnPrincipalPermissions(this, idName, {
        principal: { dataLakePrincipalIdentifier: principal },
        permissions,
        permissionsWithGrantOption: [],
        resource: table
          ? { table: { catalogId: lfCatalogId, databaseName: 'bronze', name: table } }
          : { database: { catalogId: lfCatalogId, name: 'bronze' } },
      });
      for (const t of Object.values(bronzeTables)) p.addDependency(t);
      lfGrants.push(p);
      return p;
    };
    grant('LfFirehoseBronzeDb', firehoseRole.roleArn, null, ['DESCRIBE']);
    for (const name of Object.keys(bronzeTables)) {
      const pascal = name.split('_').map((w) => w[0].toUpperCase() + w.slice(1)).join('');
      grant(`LfFirehose${pascal}`, firehoseRole.roleArn, name, ['ALL']);
      if (lh.ownerPrincipalArn) grant(`LfOwner${pascal}`, lh.ownerPrincipalArn, name, ['SELECT', 'DESCRIBE']);
    }
    if (lh.ownerPrincipalArn) grant('LfOwnerBronzeDb', lh.ownerPrincipalArn, null, ['DESCRIBE']);

    // Firehose's Iceberg destination wants ONE JSON object per record and accepts ONLY the Lambda
    // processor ("DecompressionProcessor is currently only supported for destination type S3, Splunk
    // and Snowflake" — dev deploy 2026-10-28). The transform Lambda therefore unpacks the gzip'd
    // CloudWatch Logs envelope itself and re-ingests the overflow rows (see transform.ts).
    const stream = (idName: string, name: string, destinations: string[], fn: lambda.IFunction) => {
      const processors = [{
        type: 'Lambda',
        parameters: [
          { parameterName: 'LambdaArn', parameterValue: fn.functionArn },
          { parameterName: 'BufferIntervalInSeconds', parameterValue: '60' },
          { parameterName: 'BufferSizeInMBs', parameterValue: '1' },
        ],
      }];
      const s = new firehose.CfnDeliveryStream(this, idName, {
        deliveryStreamName: name,
        deliveryStreamType: 'DirectPut',
        icebergDestinationConfiguration: {
          roleArn: firehoseRole.roleArn,
          catalogConfiguration: { catalogArn },
          destinationTableConfigurationList: destinations.map((t) => ({
            destinationDatabaseName: 'bronze', destinationTableName: t, s3ErrorOutputPrefix: `errors/${cfg.env}/${t}/`,
          })),
          appendOnly: true,
          bufferingHints: { intervalInSeconds: 60, sizeInMBs: 5 },
          processingConfiguration: { enabled: true, processors },
          s3BackupMode: 'FailedDataOnly',
          s3Configuration: {
            bucketArn: errorsBucket.bucketArn,
            roleArn: firehoseRole.roleArn,
            prefix: `backup/${cfg.env}/`,
            errorOutputPrefix: `errors/${cfg.env}/!{firehose:error-output-type}/`,
            bufferingHints: { intervalInSeconds: 60, sizeInMBs: 5 },
            compressionFormat: 'GZIP',
            encryptionConfiguration: { kmsEncryptionConfig: { awskmsKeyArn: dataKey.keyArn } },
          },
          cloudWatchLoggingOptions: { enabled: true, logGroupName: firehoseLogGroup.logGroupName, logStreamName: idName },
        },
      });
      for (const g of lfGrants) s.addDependency(g);
      s.node.addDependency(firehoseRole);
      return s;
    };
    const bedrockStream = stream('BedrockStream', bedrockStreamName, ['bedrock_invocations', 'otel_spans'], bedrockTransformFn);
    const metricsStream = stream('MetricsStream', metricsStreamName, ['cw_metrics'], metricsTransformFn);

    // --- CloudWatch Logs → Firehose subscriptions -----------------------------------------------
    const cwlRole = new iam.Role(this, 'LogsToFirehoseRole', {
      assumedBy: new iam.ServicePrincipal('logs.amazonaws.com', {
        conditions: { ArnLike: { 'aws:SourceArn': `arn:aws:logs:${cfg.region}:${cfg.account}:*` } },
      }),
    });
    cwlRole.addToPolicy(new iam.PolicyStatement({
      actions: ['firehose:PutRecord', 'firehose:PutRecordBatch'], resources: [bedrockStream.attrArn],
    }));
    new logs.CfnSubscriptionFilter(this, 'BedrockLogsSubscription', {
      logGroupName: this.bedrockLogGroup.logGroupName, destinationArn: bedrockStream.attrArn, roleArn: cwlRole.roleArn, filterPattern: '',
    });
    // X-Ray Transaction Search writes OTel spans to `aws/spans`; it exists because Transaction Search is on.
    new logs.CfnSubscriptionFilter(this, 'SpansSubscription', {
      logGroupName: 'aws/spans', destinationArn: bedrockStream.attrArn, roleArn: cwlRole.roleArn, filterPattern: '',
    });
    if (lh.enableTransactionSearch) {
      new xray.CfnTransactionSearchConfig(this, 'TransactionSearch', { indexingPercentage: 1 });
    }

    // --- CloudWatch Metric Streams → Firehose -------------------------------------------------
    const metricStreamRole = new iam.Role(this, 'MetricStreamRole', {
      assumedBy: new iam.ServicePrincipal('streams.metrics.cloudwatch.amazonaws.com'),
    });
    metricStreamRole.addToPolicy(new iam.PolicyStatement({
      actions: ['firehose:PutRecord', 'firehose:PutRecordBatch'], resources: [metricsStream.attrArn],
    }));
    new cw.CfnMetricStream(this, 'BedrockMetricStream', {
      name: tableBucketName,
      outputFormat: 'json',
      firehoseArn: metricsStream.attrArn,
      roleArn: metricStreamRole.roleArn,
      includeFilters: [{ namespace: 'AWS/Bedrock' }, { namespace: 'AWS/BedrockMantle' }],
    });

    // --- CUR 2.0 via AWS Data Exports + Glue external table -----------------------------------
    const curSpec = specs.find((s) => s.lakehouse.table === 'cur_raw')!;
    const curCols = Object.entries(curSpec.properties).filter(([c]) => c !== 'billing_period');
    const exportName = `tums-cur2-${cfg.env}`;
    const curExport = new bcm.CfnExport(this, 'CurExport', {
      export: {
        name: exportName,
        description: 'TUMS lakehouse: CUR 2.0, daily, resource-level — the billing truth the gold layer reconciles against.',
        dataQuery: {
          queryStatement: `SELECT ${curCols.map(([c]) => c).join(', ')} FROM COST_AND_USAGE_REPORT`,
          tableConfigurations: {
            COST_AND_USAGE_REPORT: {
              TIME_GRANULARITY: 'DAILY', INCLUDE_RESOURCES: 'TRUE',
              INCLUDE_SPLIT_COST_ALLOCATION_DATA: 'FALSE', INCLUDE_MANUAL_DISCOUNT_COMPATIBILITY: 'FALSE',
            },
          },
        },
        destinationConfigurations: {
          s3Destination: {
            s3Bucket: curBucket.bucketName,
            s3Prefix: 'cur2',
            s3Region: cfg.region,
            s3OutputConfigurations: { format: 'PARQUET', compression: 'PARQUET', outputType: 'CUSTOM', overwrite: 'OVERWRITE_REPORT' },
          },
        },
        refreshCadence: { frequency: 'SYNCHRONOUS' },
      },
    });
    // The export API checks the bucket policy synchronously — the policy must exist first.
    curExport.node.addDependency(curBucket.policy!);
    const curLocation = `s3://${curBucket.bucketName}/cur2/${exportName}/data/`;
    new glue.CfnTable(this, 'CurRawTable', {
      catalogId: cfg.account,
      databaseName: `token_monitoring_${cfg.env}`,
      tableInput: {
        name: 'cur_raw',
        tableType: 'EXTERNAL_TABLE',
        description: 'CUR 2.0 lines as delivered by AWS Data Exports (bronze; see spec/lakehouse/bronze.cur_raw.schema.json).',
        parameters: {
          classification: 'parquet',
          'projection.enabled': 'true',
          'projection.billing_period.type': 'date',
          'projection.billing_period.format': 'yyyy-MM',
          'projection.billing_period.range': '2026-06,NOW',
          'projection.billing_period.interval': '1',
          'projection.billing_period.interval.unit': 'MONTHS',
          'storage.location.template': `${curLocation}BILLING_PERIOD=\${billing_period}/`,
        },
        partitionKeys: [{ name: 'billing_period', type: 'string' }],
        storageDescriptor: {
          location: curLocation,
          inputFormat: 'org.apache.hadoop.hive.ql.io.parquet.MapredParquetInputFormat',
          outputFormat: 'org.apache.hadoop.hive.ql.io.parquet.MapredParquetOutputFormat',
          serdeInfo: { serializationLibrary: 'org.apache.hadoop.hive.ql.io.parquet.serde.ParquetHiveSerDe' },
          columns: curCols.map(([name, prop]) => ({ name, type: glueType(prop) })),
        },
      },
    });

    // --- Glue zero-ETL: DynamoDB (dora, registry) → Glue database ------------------------------
    // Behind lakehouse.enableZeroEtl (default off). The first dev deploy (2026-10-28) was rejected by
    // Glue: for a DynamoDB source the IntegrationResourceProperty must not carry the table ARN ("The
    // glue connection ARN … is invalid"), and each failed first create costs a 15-minute S3 Tables
    // name cooldown, so the bronze core ships first and this lands when the resource shape is proven.
    if (cfg.lakehouse?.enableZeroEtl === true) {
      const zeroEtlSourceRole = new iam.Role(this, 'ZeroEtlSourceRole', { assumedBy: new iam.ServicePrincipal('glue.amazonaws.com') });
      zeroEtlSourceRole.addToPolicy(new iam.PolicyStatement({
        actions: ['dynamodb:DescribeTable', 'dynamodb:ExportTableToPointInTime', 'dynamodb:DescribeExport', 'dynamodb:DescribeContinuousBackups', 'dynamodb:DescribeStream', 'dynamodb:GetRecords', 'dynamodb:GetShardIterator', 'dynamodb:UpdateTable'],
        resources: [tables.dora.tableArn, `${tables.dora.tableArn}/*`, tables.tenants.tableArn, `${tables.tenants.tableArn}/*`],
      }));
      const zeroEtlTargetRole = new iam.Role(this, 'ZeroEtlTargetRole', { assumedBy: new iam.ServicePrincipal('glue.amazonaws.com') });
      zeroEtlTargetRole.addToPolicy(new iam.PolicyStatement({
        actions: ['glue:*'],
        resources: [
          `arn:aws:glue:${cfg.region}:${cfg.account}:catalog`,
          `arn:aws:glue:${cfg.region}:${cfg.account}:database/token_monitoring_${cfg.env}`,
          `arn:aws:glue:${cfg.region}:${cfg.account}:table/token_monitoring_${cfg.env}/*`,
        ],
      }));
      curatedBucket.grantReadWrite(zeroEtlTargetRole, 'zero-etl/*');
      curatedBucket.grantRead(zeroEtlTargetRole);
      dataKey.grantEncryptDecrypt(zeroEtlTargetRole);
      zeroEtlTargetRole.addToPolicy(new iam.PolicyStatement({ actions: ['lakeformation:GetDataAccess'], resources: ['*'] }));
      const glueDbArn = `arn:aws:glue:${cfg.region}:${cfg.account}:database/token_monitoring_${cfg.env}`;
      const targetProps = new glue.CfnIntegrationResourceProperty(this, 'ZeroEtlTargetProps', {
        resourceArn: glueDbArn,
        targetProcessingProperties: { roleArn: zeroEtlTargetRole.roleArn, kmsArn: dataKey.keyArn },
      });
      for (const [name, table] of [['Dora', tables.dora], ['Registry', tables.tenants]] as const) {
        const sourceProps = new glue.CfnIntegrationResourceProperty(this, `ZeroEtl${name}SourceProps`, {
          resourceArn: table.tableArn,
          sourceProcessingProperties: { roleArn: zeroEtlSourceRole.roleArn },
        });
        const integration = new glue.CfnIntegration(this, `ZeroEtl${name}`, {
          integrationName: `tums-${cfg.env}-${name.toLowerCase()}`,
          sourceArn: table.tableArn,
          targetArn: glueDbArn,
          kmsKeyId: dataKey.keyArn,
          description: `TUMS lakehouse bronze mirror of the ${name} DynamoDB table.`,
        });
        integration.addDependency(sourceProps);
        integration.addDependency(targetProps);
      }
    }

    // --- Alarms → governance topic -------------------------------------------------------------
    const act = new cwActions.SnsAction(alertTopic);
    const alarm = (idName: string, metric: cw.Metric, threshold: number, op: cw.ComparisonOperator, desc: string) => {
      metric.createAlarm(this, idName, {
        alarmDescription: desc, threshold, evaluationPeriods: 1, comparisonOperator: op, treatMissingData: cw.TreatMissingData.NOT_BREACHING,
      }).addAlarmAction(act);
    };
    for (const [label, s] of [['Bedrock', bedrockStream], ['Metrics', metricsStream]] as const) {
      const dims = { DeliveryStreamName: s.deliveryStreamName! };
      alarm(`${label}StreamDeliveryAlarm`,
        new cw.Metric({ namespace: 'AWS/Firehose', metricName: 'DeliveryToIceberg.Success', dimensionsMap: dims, statistic: 'Average', period: cdk.Duration.minutes(15) }),
        1, cw.ComparisonOperator.LESS_THAN_THRESHOLD, `Lakehouse ${label} Firehose (${cfg.env}): deliveries to the bronze Iceberg tables are failing.`);
      alarm(`${label}StreamThrottleAlarm`,
        new cw.Metric({ namespace: 'AWS/Firehose', metricName: 'ThrottledRecords', dimensionsMap: dims, statistic: 'Sum', period: cdk.Duration.minutes(5) }),
        0, cw.ComparisonOperator.GREATER_THAN_THRESHOLD, `Lakehouse ${label} Firehose (${cfg.env}): records are being throttled.`);
    }
    for (const [label, fn] of [['Bedrock', bedrockTransformFn], ['Metrics', metricsTransformFn]] as const) {
      alarm(`${label}TransformErrorsAlarm`, fn.metricErrors({ period: cdk.Duration.minutes(5), statistic: 'Sum' }),
        0, cw.ComparisonOperator.GREATER_THAN_THRESHOLD, `Lakehouse ${label} transform Lambda (${cfg.env}) raised errors — records are landing in the Firehose error prefix.`);
    }

    new cdk.CfnOutput(this, 'TableBucketArn', { value: tableBucket.attrTableBucketArn });
    new cdk.CfnOutput(this, 'BedrockLogGroupName', { value: this.bedrockLogGroup.logGroupName });
    new cdk.CfnOutput(this, 'BodiesBucketName', { value: this.bodiesBucket.bucketName });
    new cdk.CfnOutput(this, 'SmusProject', { value: `${lh.smusDomainId}/${lh.smusProjectId}` });
  }
}
