import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as athena from 'aws-cdk-lib/aws-athena';
import * as glue from 'aws-cdk-lib/aws-glue';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { EnvConfig } from '../config';

interface Props extends cdk.StackProps {
  cfg: EnvConfig;
}

export interface DataTables {
  readonly aggregates: dynamodb.Table; // pre-rolled KPIs for fast dashboard reads
  readonly anomalies: dynamodb.Table; // mirror of anomaly/alert events
  readonly tenants: dynamodb.Table; // tenant registry & config
  readonly dora: dynamodb.Table; // DORA: tracked-repo registry + merged PRs + incident issues
}

/**
 * Storage + analytics backbone: KMS-encrypted S3 (raw + curated), Glue catalog, Athena
 * workgroup, and DynamoDB hot-read tables. (Reliability, Security, Cost pillars.)
 */
export class DataStack extends cdk.Stack {
  public readonly rawLogBucket: s3.Bucket;
  public readonly curatedBucket: s3.Bucket;
  public readonly tables: DataTables;
  public readonly athena: { workgroupName: string; resultsBucket: s3.Bucket };
  public readonly dataKey: kms.Key;

  constructor(scope: Construct, id: string, props: Props) {
    super(scope, id, props);
    const { cfg } = props;

    const key = new kms.Key(this, 'DataKey', {
      enableKeyRotation: true,
      description: 'CMK for token-usage-monitoring data at rest',
    });
    this.dataKey = key;

    // Allow Amazon Bedrock to encrypt model-invocation logs written to the KMS-encrypted raw
    // bucket. Scoped to this account as source (per the Bedrock logging docs).
    key.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'AllowBedrockToUseKey',
        principals: [new iam.ServicePrincipal('bedrock.amazonaws.com')],
        actions: ['kms:GenerateDataKey'],
        resources: ['*'],
        conditions: { StringEquals: { 'aws:SourceAccount': cfg.account } },
      }),
    );

    // No public access anywhere (Security pillar).
    const secureBucket = (idName: string, name: string, expireDays?: number) =>
      new s3.Bucket(this, idName, {
        bucketName: name,
        encryption: s3.BucketEncryption.KMS,
        encryptionKey: key,
        enforceSSL: true,
        blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
        versioned: true,
        // Versioned buckets keep deleted/overwritten objects as non-current versions forever unless told
        // otherwise — the raw-log retention promise was only true for current versions (feature-49, audit #15).
        lifecycleRules: [{
          ...(expireDays ? { expiration: cdk.Duration.days(expireDays) } : {}),
          noncurrentVersionExpiration: cdk.Duration.days(1),
          abortIncompleteMultipartUploadAfter: cdk.Duration.days(7),
          transitions: [],
        }],
        removalPolicy: cdk.RemovalPolicy.RETAIN, // protect audit data
      });

    this.rawLogBucket = secureBucket('RawLogBucket', cfg.logBucketName, cfg.rawLogRetentionDays);
    this.curatedBucket = secureBucket('CuratedBucket', cfg.curatedBucketName);
    const resultsBucket = secureBucket('AthenaResults', `${cfg.curatedBucketName}-athena-results`, 30);

    // Glue database for the Bedrock invocation-log tables.
    const glueDb = new glue.CfnDatabase(this, 'GlueDb', {
      catalogId: cfg.account,
      // locationUri: Glue zero-ETL integrations (LakehouseStack) target this database and write
      // their Iceberg tables under the database location.
      databaseInput: { name: `token_monitoring_${cfg.env}`, locationUri: `s3://${this.curatedBucket.bucketName}/zero-etl/` },
    });

    // The table the API queries: flat Parquet the ETL writes under usage/dt=YYYY-MM-DD/ (columns =
    // etl.py flatten_record). It deliberately does NOT sit on Bedrock's delivery prefix — that prefix
    // also holds the >100 KB request/response bodies (`data/`), and a body shaped unlike the record
    // schema fails every Athena query over it (qa F-PR75-001, 2026-10-23). Partition projection
    // means no partition registration, and `dt` predicates prune the scan.
    const curatedTable = new glue.CfnTable(this, 'CuratedInvocationsTable', {
      catalogId: cfg.account,
      databaseName: `token_monitoring_${cfg.env}`,
      tableInput: {
        name: 'bedrock_invocations_curated',
        tableType: 'EXTERNAL_TABLE',
        description: 'Bedrock invocation records flattened by the ETL; no bodies. Source for the dashboard Full view.',
        parameters: {
          classification: 'parquet',
          'parquet.compression': 'SNAPPY',
          'projection.enabled': 'true',
          'projection.dt.type': 'date',
          'projection.dt.format': 'yyyy-MM-dd',
          'projection.dt.range': '2026-06-01,NOW',
          'projection.dt.interval': '1',
          'projection.dt.interval.unit': 'DAYS',
          'storage.location.template': `s3://${this.curatedBucket.bucketName}/usage/dt=\${dt}/`,
        },
        partitionKeys: [{ name: 'dt', type: 'string' }],
        storageDescriptor: {
          location: `s3://${this.curatedBucket.bucketName}/usage/`,
          inputFormat: 'org.apache.hadoop.hive.ql.io.parquet.MapredParquetInputFormat',
          outputFormat: 'org.apache.hadoop.hive.ql.io.parquet.MapredParquetOutputFormat',
          serdeInfo: { serializationLibrary: 'org.apache.hadoop.hive.ql.io.parquet.serde.ParquetHiveSerDe' },
          columns: [
            { name: 'timestamp', type: 'string' },
            { name: 'accountId', type: 'string' },
            { name: 'region', type: 'string' },
            { name: 'requestId', type: 'string' },
            { name: 'operation', type: 'string' },
            { name: 'modelId', type: 'string' },
            { name: 'inferenceRegion', type: 'string' },
            { name: 'identityArn', type: 'string' },
            { name: 'requestMetadata', type: 'string' },
            { name: 'inputTokenCount', type: 'bigint' },
            { name: 'cacheReadInputTokenCount', type: 'bigint' },
            { name: 'cacheWriteInputTokenCount', type: 'bigint' },
            { name: 'outputTokenCount', type: 'bigint' },
          ],
        },
      },
    });
    curatedTable.addDependency(glueDb);

    const workgroup = new athena.CfnWorkGroup(this, 'Workgroup', {
      name: `token-monitoring-${cfg.env}`,
      recursiveDeleteOption: true,
      workGroupConfiguration: {
        enforceWorkGroupConfiguration: true,
        // A single query may scan at most 10 GB (≈ $0.05): the curated table is ~1 GB/month, so legitimate
        // all-time queries fit and a runaway one is cut off (feature-49, audit #6).
        bytesScannedCutoffPerQuery: 10 * 1024 ** 3,
        resultConfiguration: {
          outputLocation: `s3://${resultsBucket.bucketName}/results/`,
          encryptionConfiguration: { encryptionOption: 'SSE_KMS', kmsKey: key.keyArn },
        },
      },
    });
    this.athena = { workgroupName: workgroup.name!, resultsBucket };

    const table = (idName: string, name: string) =>
      new dynamodb.Table(this, idName, {
        tableName: `${name}-${cfg.env}`,
        partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
        sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
        billingMode: dynamodb.BillingMode.PAY_PER_REQUEST, // scale-to-zero (Cost pillar)
        encryption: dynamodb.TableEncryption.CUSTOMER_MANAGED,
        encryptionKey: key,
        pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true }, // (Reliability pillar)
        // Items that carry `expiresAt` (epoch seconds) age out: the aggregator's per-object processed
        // markers and the API's query→tenant bindings (feature-47). Rollups never set it.
        timeToLiveAttribute: 'expiresAt',
        deletionProtection: true, // RETAIN stops CloudFormation, not a DeleteTable call
        removalPolicy: cdk.RemovalPolicy.RETAIN,
      });

    this.tables = {
      aggregates: table('Aggregates', 'tums-aggregates'),
      anomalies: table('Anomalies', 'tums-anomalies'),
      tenants: table('Tenants', 'tums-tenants'),
      dora: table('Dora', 'tums-dora'),
    };
  }
}
