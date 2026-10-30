import * as fs from 'fs';
import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3tables from 'aws-cdk-lib/aws-s3tables';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as tasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lakeformation from 'aws-cdk-lib/aws-lakeformation';
import * as athenaCfn from 'aws-cdk-lib/aws-athena';
import * as datazone from 'aws-cdk-lib/aws-datazone';
import { Construct } from 'constructs';
import { EnvConfig } from '../config';
import { BACKEND_ROOT, BACKEND_LOCK, lambdaEntry } from './paths';
import { LakehouseSpec, SPEC_DIR, icebergFields } from '../lakehouse/spec';

export interface LakehouseSilverProps {
  cfg: EnvConfig;
  dataKey: kms.Key;
  tableBucket: s3tables.CfnTableBucket;
  tableBucketName: string;
  /** Glue federated-catalog ARN for the table bucket and its Lake Formation catalog id. */
  catalogArn: string;
  lfCatalogId: string;
  /** Bronze tables (already created) and the silver namespace they sit beside. */
  bronzeTables: Record<string, s3tables.CfnTable>;
  silverNamespace: s3tables.CfnNamespace;
  silverSpecs: LakehouseSpec[];
  tenantsTable: dynamodb.ITable;
  athena: { workgroupName: string; resultsBucket: s3.IBucket };
  /** Glue resource ARNs for the federated catalog (shared with the Firehose role). */
  glueCatalogResources: string[];
  /** Directory of silver_*.sql / quality_*.sql files; default spec/lakehouse/sql. */
  sqlDir?: string;
  grant: (idName: string, principal: string, db: string, table: string | null, permissions: string[]) => lakeformation.CfnPrincipalPermissions;
}

/**
 * Lakehouse P2 — the silver layer: six tables from the spec, one role for every silver job, the
 * daily dim_model refresh, the hourly registry snapshot, and the hourly Step Functions run of the
 * spec/lakehouse/sql files (silver_* transforms, then quality_* gates). Attribution and tenant
 * normalisation are recomputed in SQL from bronze + the registry snapshot, so a registry change
 * reaches history without a replay.
 */
export class LakehouseSilver extends Construct {
  /** Dedicated Athena workgroup (SSE_S3 results) — see the note where it is created. */
  public readonly workgroupName: string;
  public readonly silverTables: Record<string, s3tables.CfnTable> = {};
  public readonly jobsRole: iam.Role;
  public readonly sfnRole: iam.Role;
  public readonly dimModelRefreshFn: lambda.Function;
  public readonly registrySnapshotFn: lambda.Function;
  public readonly qualityGateFn: lambda.Function;
  public readonly stateMachine: sfn.StateMachine;
  public readonly lfGrants: lakeformation.CfnPrincipalPermissions[] = [];

  constructor(scope: Construct, id: string, props: LakehouseSilverProps) {
    super(scope, id);
    const { cfg, dataKey, tableBucket, tableBucketName, catalogArn, lfCatalogId, bronzeTables, silverNamespace, silverSpecs, tenantsTable, athena, glueCatalogResources, grant } = props;
    const stack = cdk.Stack.of(this);
    const catalog = `s3tablescatalog/${tableBucketName}`;

    // --- Silver tables from the spec --------------------------------------------------------
    for (const spec of silverSpecs) {
      const fields = icebergFields(spec);
      const partitionCol = spec.lakehouse.partition[0];
      const pascal = spec.lakehouse.table.split('_').map((w) => w[0].toUpperCase() + w.slice(1)).join('');
      const t = new s3tables.CfnTable(this, `Silver${pascal}`, {
        tableBucketArn: tableBucket.attrTableBucketArn,
        namespace: 'silver',
        tableName: spec.lakehouse.table,
        openTableFormat: 'ICEBERG',
        icebergMetadata: {
          icebergSchema: { schemaFieldList: fields.map((f, i) => ({ id: i + 1, name: f.name, type: f.type, required: f.required })) },
          ...(partitionCol
            ? { icebergPartitionSpec: { fields: [{ name: partitionCol, sourceId: fields.findIndex((f) => f.name === partitionCol) + 1, transform: 'identity', fieldId: 1000 }] } }
            : {}),
        },
        compaction: { status: 'enabled', targetFileSizeMb: 128 },
        // '90d' retention → 2160 h of snapshots; everything else is kept like bronze (100 years).
        snapshotManagement: { status: 'enabled', minSnapshotsToKeep: 1, maxSnapshotAgeHours: spec.lakehouse.retention === '90d' ? 2160 : 876000 },
      });
      t.addDependency(silverNamespace);
      this.silverTables[spec.lakehouse.table] = t;
    }
    const allTables = [...Object.values(bronzeTables), ...Object.values(this.silverTables)];

    // --- Roles: one for the silver Lambdas, one for the Step Functions run. (A single composite role
    // creates a CloudFormation cycle: the state machine's policy must name the Lambda it invokes,
    // and that Lambda must name the role.) Both receive the same Lake Formation grants.
    this.jobsRole = new iam.Role(this, 'SilverJobsRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole')],
    });
    this.sfnRole = new iam.Role(this, 'SilverSfnRole', { assumedBy: new iam.ServicePrincipal('states.amazonaws.com') });
    const both = (st: iam.PolicyStatement) => { this.jobsRole.addToPolicy(st); this.sfnRole.addToPolicy(st); };
    both(new iam.PolicyStatement({
      actions: ['glue:GetTable', 'glue:GetTables', 'glue:GetDatabase', 'glue:GetDatabases', 'glue:UpdateTable', 'glue:GetCatalog', 'glue:GetCatalogs', 'glue:GetPartitions', 'glue:CreateTable'],
      resources: glueCatalogResources,
    }));
    both(new iam.PolicyStatement({
      actions: ['glue:GetTable', 'glue:GetTables', 'glue:GetDatabase', 'glue:GetPartitions'],
      resources: [
        `arn:aws:glue:${cfg.region}:${cfg.account}:catalog`,
        `arn:aws:glue:${cfg.region}:${cfg.account}:database/token_monitoring_${cfg.env}`,
        `arn:aws:glue:${cfg.region}:${cfg.account}:table/token_monitoring_${cfg.env}/*`,
      ],
    }));
    both(new iam.PolicyStatement({
      actions: ['s3tables:*'],
      resources: [tableBucket.attrTableBucketArn, `${tableBucket.attrTableBucketArn}/*`],
    }));
    both(new iam.PolicyStatement({ actions: ['lakeformation:GetDataAccess'], resources: ['*'] }));
    // Athena INSERT/MERGE into S3 Tables fails with INTERNAL_ERROR_QUERY_ENGINE when the workgroup's
    // result encryption is SSE_KMS (dev, 2026-10-30: identical statement succeeded under SSE_S3 and in
    // `primary`). The dashboard's KMS workgroup stays as it is; lakehouse jobs get their own.
    const lakehouseWorkgroup = new athenaCfn.CfnWorkGroup(this, 'LakehouseWorkgroup', {
      name: `tums-lakehouse-${cfg.env}`,
      recursiveDeleteOption: true,
      workGroupConfiguration: {
        enforceWorkGroupConfiguration: true, // a job cannot redirect its own output or drop encryption
        // 50 GiB per query: the 90-day attribution MERGE reads bronze + silver; today's whole lakehouse is
        // far below this, and a runaway join should fail rather than bill.
        bytesScannedCutoffPerQuery: 50 * 1024 * 1024 * 1024,
        resultConfiguration: {
          outputLocation: `s3://${athena.resultsBucket.bucketName}/lakehouse/`,
          // SSE_S3, not KMS: Athena writes to S3 Tables fail under SSE_KMS; silver results carry no bodies.
          encryptionConfiguration: { encryptionOption: 'SSE_S3' },
        },
      },
    });
    this.workgroupName = lakehouseWorkgroup.name!;
    both(new iam.PolicyStatement({
      actions: ['athena:StartQueryExecution', 'athena:GetQueryExecution', 'athena:GetQueryResults', 'athena:StopQueryExecution', 'athena:GetWorkGroup'],
      resources: [`arn:aws:athena:${cfg.region}:${cfg.account}:workgroup/${lakehouseWorkgroup.name}`],
    }));
    both(new iam.PolicyStatement({
      actions: ['athena:GetDataCatalog', 'athena:ListDataCatalogs'],
      resources: [`arn:aws:athena:${cfg.region}:${cfg.account}:datacatalog/*`],
    }));
    athena.resultsBucket.grantReadWrite(this.jobsRole);
    athena.resultsBucket.grantReadWrite(this.sfnRole);
    dataKey.grantEncryptDecrypt(this.jobsRole);
    dataKey.grantEncryptDecrypt(this.sfnRole);
    this.jobsRole.addToPolicy(new iam.PolicyStatement({
      actions: ['bedrock:ListFoundationModels', 'bedrock:ListInferenceProfiles', 'bedrock:ListProvisionedModelThroughputs', 'bedrock:ListCustomModels', 'bedrock:ListImportedModels', 'bedrock:GetInferenceProfile'],
      resources: ['*'],
    }));
    // The Price List API is served from us-east-1 (and ap-south-1); the action is not resource-scoped.
    this.jobsRole.addToPolicy(new iam.PolicyStatement({ actions: ['pricing:GetProducts', 'pricing:DescribeServices'], resources: ['*'] }));
    tenantsTable.grantReadData(this.jobsRole);

    // Lake Formation: jobs role ALL on silver, SELECT on bronze, DESCRIBE on both databases.
    const push = (g: lakeformation.CfnPrincipalPermissions) => { for (const t of allTables) g.addDependency(t); this.lfGrants.push(g); return g; };
    for (const [tag, role] of [['Jobs', this.jobsRole], ['Sfn', this.sfnRole]] as const) {
      push(grant(`Lf${tag}BronzeDb`, role.roleArn, 'bronze', null, ['DESCRIBE']));
      push(grant(`Lf${tag}SilverDb`, role.roleArn, 'silver', null, ['DESCRIBE']));
      for (const name of Object.keys(bronzeTables)) push(grant(`Lf${tag}Bronze${pascalOf(name)}`, role.roleArn, 'bronze', name, ['SELECT', 'DESCRIBE']));
      for (const name of Object.keys(this.silverTables)) push(grant(`Lf${tag}Silver${pascalOf(name)}`, role.roleArn, 'silver', name, ['ALL']));
    }

    // --- Lambdas: dim_model refresh (daily), registry snapshot (hourly), quality gate ------------
    const athenaEnv = {
      TABLE_BUCKET: tableBucketName,
      CATALOG: catalog,
      ATHENA_WORKGROUP: lakehouseWorkgroup.name!,
      ATHENA_OUTPUT: `s3://${athena.resultsBucket.bucketName}/lakehouse/`,
      SILVER_DATABASE: 'silver',
    };
    const fn = (idName: string, file: string, env: Record<string, string>, timeoutMin: number): lambda.Function => {
      const common = {
        runtime: lambda.Runtime.NODEJS_22_X, role: this.jobsRole, timeout: cdk.Duration.minutes(timeoutMin),
        memorySize: 1024, tracing: lambda.Tracing.ACTIVE, environment: env,
      };
      const entry = lambdaEntry('lakehouse', file);
      if (fs.existsSync(entry)) {
        return new NodejsFunction(this, idName, { ...common, entry, projectRoot: BACKEND_ROOT, depsLockFilePath: BACKEND_LOCK, handler: 'handler' });
      }
      // Parallel chains: the backend handler is not on disk yet. Keep the synth deployable but loud —
      // the stand-in throws on every invocation and the warning names the missing file.
      cdk.Annotations.of(this).addWarningV2('tums:lakehouse:pending-handler', `backend/lambdas/lakehouse/${file} does not exist yet; deploying a stand-in that throws`);
      return new lambda.Function(this, idName, {
        ...common, handler: 'index.handler',
        code: lambda.Code.fromInline(`exports.handler = async () => { throw new Error('pending handler: backend/lambdas/lakehouse/${file} has not been written yet'); };`),
      });
    };
    this.dimModelRefreshFn = fn('DimModelRefreshFn', 'dim-model-refresh.ts', { ...athenaEnv, TABLE_DIM_MODEL: 'dim_model' }, 10);
    this.registrySnapshotFn = fn('RegistrySnapshotFn', 'registry-snapshot.ts', { ...athenaEnv, TENANTS_TABLE: tenantsTable.tableName, TABLE_PROJECT_REGISTRY: 'project_registry' }, 10);
    this.qualityGateFn = fn('QualityGateFn', 'quality-gate.ts', { ...athenaEnv, QUALITY_GATE: 'true' }, 2);
    new events.Rule(this, 'DimModelRefreshSchedule', {
      schedule: events.Schedule.cron({ hour: '5', minute: '0' }), // 05:00 UTC daily
      targets: [new targets.LambdaFunction(this.dimModelRefreshFn)],
    });
    new events.Rule(this, 'RegistrySnapshotSchedule', {
      schedule: events.Schedule.cron({ minute: '5' }), // hourly at :05, before the :15 silver run
      targets: [new targets.LambdaFunction(this.registrySnapshotFn)],
    });

    // --- Hourly Step Functions run of spec/lakehouse/sql ----------------------------------------
    const sqlDir = props.sqlDir ?? path.join(SPEC_DIR, 'sql');
    const files = fs.existsSync(sqlDir) ? fs.readdirSync(sqlDir).filter((f) => f.endsWith('.sql')).sort() : [];
    const silverSql = files.filter((f) => f.startsWith('silver_'));
    const qualitySql = files.filter((f) => f.startsWith('quality_'));
    const substitute = (sql: string) => sql
      .replace(/\$\{CATALOG\}/g, `"${catalog}"`)
      .replace(/\$\{GLUE_DB\}/g, `token_monitoring_${cfg.env}`)
      .replace(/\$\{ENV\}/g, cfg.env);
    const athenaTask = (idName: string, file: string) => new tasks.AthenaStartQueryExecution(this, idName, {
      queryString: substitute(fs.readFileSync(path.join(sqlDir, file), 'utf8')),
      integrationPattern: sfn.IntegrationPattern.RUN_JOB,
      workGroup: lakehouseWorkgroup.name!,
      queryExecutionContext: { catalogName: catalog, databaseName: 'silver' },
      resultConfiguration: { outputLocation: { bucketName: athena.resultsBucket.bucketName, objectKey: 'lakehouse/silver' } },
      resultPath: `$.${file.replace(/\W/g, '_')}`,
    });
    let first: sfn.IChainable | undefined;
    let last: sfn.INextable | undefined;
    const append = (state: sfn.State & sfn.INextable) => { if (last) last.next(state); else first = state; last = state; };
    for (const f of silverSql) append(athenaTask(`Sql${pascalOf(f.replace(/\.sql$/, ''))}`, f));
    for (const f of qualitySql) {
      const q = athenaTask(`Sql${pascalOf(f.replace(/\.sql$/, ''))}`, f);
      // A quality query is written so that any returned row is a violation; the gate reads the
      // results and throws, failing the execution (and the alarm) when rows exist.
      const gate = new tasks.LambdaInvoke(this, `Gate${pascalOf(f.replace(/\.sql$/, ''))}`, {
        lambdaFunction: this.qualityGateFn,
        payload: sfn.TaskInput.fromObject({ queryExecutionId: sfn.JsonPath.stringAt(`$.${f.replace(/\W/g, '_')}.QueryExecution.QueryExecutionId`), check: f }),
        resultPath: sfn.JsonPath.DISCARD,
      });
      append(q);
      append(gate);
    }
    if (!first) {
      // No SQL files on disk at synth time (another chain writes spec/lakehouse/sql): keep the state
      // machine deployable so the schedule and alarm exist; it becomes real as soon as the files land.
      first = new sfn.Pass(this, 'NoSilverSqlYet', { comment: 'spec/lakehouse/sql is empty — nothing to run' });
    }
    this.stateMachine = new sfn.StateMachine(this, 'LakehouseSilverSfn', {
      definitionBody: sfn.DefinitionBody.fromChainable(first),
      role: this.sfnRole,
      timeout: cdk.Duration.minutes(50),
      tracingEnabled: true,
    });
    for (const g of this.lfGrants) this.stateMachine.node.addDependency(g);
    new events.Rule(this, 'SilverSchedule', {
      schedule: events.Schedule.cron({ minute: '15' }), // hourly at :15
      targets: [new targets.SfnStateMachine(this.stateMachine)],
    });

    // --- SMUS / DataZone: publish the silver namespace into the project (flagged) ---------------
    if (cfg.lakehouse?.enableSmusPublish === true) {
      const dzRole = new iam.Role(this, 'SmusDataAccessRole', {
        assumedBy: new iam.ServicePrincipal('datazone.amazonaws.com', { conditions: { StringEquals: { 'aws:SourceAccount': cfg.account } } }),
      });
      dzRole.addToPolicy(new iam.PolicyStatement({ actions: ['glue:GetTable', 'glue:GetTables', 'glue:GetDatabase', 'glue:GetDatabases', 'glue:GetCatalog', 'glue:GetCatalogs', 'glue:GetPartitions'], resources: glueCatalogResources }));
      dzRole.addToPolicy(new iam.PolicyStatement({ actions: ['lakeformation:GetDataAccess'], resources: ['*'] }));
      push(grant('LfSmusSilverDb', dzRole.roleArn, 'silver', null, ['DESCRIBE']));
      for (const name of Object.keys(this.silverTables)) push(grant(`LfSmusSilver${pascalOf(name)}`, dzRole.roleArn, 'silver', name, ['DESCRIBE', 'SELECT']));
      new datazone.CfnDataSource(this, 'SmusSilverDataSource', {
        name: `tums-${cfg.env}-silver`,
        type: 'GLUE',
        domainIdentifier: cfg.lakehouse.smusDomainId,
        projectIdentifier: cfg.lakehouse.smusProjectId,
        enableSetting: 'ENABLED',
        publishOnImport: true,
        configuration: {
          glueRunConfiguration: {
            dataAccessRole: dzRole.roleArn,
            catalogName: catalog,
            relationalFilterConfigurations: [{ databaseName: 'silver' }],
          },
        },
        schedule: { schedule: 'cron(30 * * * ? *)', timezone: 'UTC' },
      });
    }
    void catalogArn; void lfCatalogId; void stack;
  }
}

function pascalOf(name: string): string {
  return name.split(/[_\-.]/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join('');
}
