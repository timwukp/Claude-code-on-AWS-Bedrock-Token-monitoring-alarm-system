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
        lifecycleRules: expireDays
          ? [{ expiration: cdk.Duration.days(expireDays), transitions: [] }]
          : undefined,
        removalPolicy: cdk.RemovalPolicy.RETAIN, // protect audit data
      });

    this.rawLogBucket = secureBucket('RawLogBucket', cfg.logBucketName, cfg.rawLogRetentionDays);
    this.curatedBucket = secureBucket('CuratedBucket', cfg.curatedBucketName);
    const resultsBucket = secureBucket('AthenaResults', `${cfg.curatedBucketName}-athena-results`, 30);

    // Glue database for the Bedrock invocation-log tables (created by ETL/DDL; see docs).
    new glue.CfnDatabase(this, 'GlueDb', {
      catalogId: cfg.account,
      databaseInput: { name: `token_monitoring_${cfg.env}` },
    });

    const workgroup = new athena.CfnWorkGroup(this, 'Workgroup', {
      name: `token-monitoring-${cfg.env}`,
      recursiveDeleteOption: true,
      workGroupConfiguration: {
        enforceWorkGroupConfiguration: true,
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
        removalPolicy: cdk.RemovalPolicy.RETAIN,
      });

    this.tables = {
      aggregates: table('Aggregates', 'tums-aggregates'),
      anomalies: table('Anomalies', 'tums-anomalies'),
      tenants: table('Tenants', 'tums-tenants'),
    };
  }
}
