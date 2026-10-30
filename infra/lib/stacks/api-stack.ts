import * as cdk from 'aws-cdk-lib';
import * as apigw from 'aws-cdk-lib/aws-apigateway';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cwActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';
import { EnvConfig } from '../config';
import { DataTables } from './data-stack';
import { BACKEND_ROOT, BACKEND_LOCK, lambdaEntry } from './paths';

interface Props extends cdk.StackProps {
  cfg: EnvConfig;
  userPool: cognito.UserPool;
  tables: DataTables;
  athena: { workgroupName: string; resultsBucket: s3.Bucket };
  rawLogBucket: s3.Bucket;
  curatedBucket: s3.Bucket;
  dataKey: kms.Key;
  /** Alarms (API 5XX) notify here (feature-49). */
  alertTopic: sns.ITopic;
  /** From the Dora stack: the collector the API invokes on demand + the GitHub token secret. */
  dora: { collectorFn: lambda.IFunction; githubSecret: secretsmanager.ISecret };
}

/**
 * REST API: API Gateway + Cognito authorizer + per-route Lambda. Each Lambda gets least-
 * privilege access to only the resources it needs (Security pillar). Hot reads come from
 * DynamoDB aggregates; forensic reads start async Athena queries (Performance pillar).
 */
export class ApiStack extends cdk.Stack {
  public readonly restApi: apigw.RestApi;

  constructor(scope: Construct, id: string, props: Props) {
    super(scope, id, props);
    const { cfg, userPool, tables, athena, rawLogBucket, curatedBucket, dataKey, dora, alertTopic } = props;

    // CORS: restrict to the configured origins. "*" is a dev-only convenience (feature-47): any other
    // environment must name its frontend origin(s) or synth refuses.
    const allowedOrigins = cfg.api?.allowedOrigins?.length ? cfg.api.allowedOrigins : undefined;
    if (!allowedOrigins && cfg.env !== 'dev' && cfg.env !== 'ci') {
      throw new Error(`config ${cfg.env}: api.allowedOrigins is required outside dev/ci (the CloudFront domain, e.g. https://dxxxx.cloudfront.net)`);
    }

    const commonEnv = {
      AGGREGATES_TABLE: tables.aggregates.tableName,
      ANOMALIES_TABLE: tables.anomalies.tableName,
      TENANTS_TABLE: tables.tenants.tableName,
      DORA_TABLE: tables.dora.tableName,
      ATHENA_WORKGROUP: athena.workgroupName,
      GLUE_DATABASE: `token_monitoring_${cfg.env}`,
      // Athena templates read the ETL's curated Parquet table, never the raw delivery prefix
      // (bodies live there — qa F-PR75-001). 'raw' exists only as a break-glass comparison.
      INVOCATION_SOURCE: 'curated',
      // The Lambda response's Access-Control-Allow-Origin must match the preflight. A single
      // origin is echoed directly; multiple/none → "*" (demo). Production: set one origin.
      ALLOWED_ORIGIN: allowedOrigins?.length === 1 ? allowedOrigins[0] : '*',
    };

    const fn = (name: string, entryFile: string) =>
      new NodejsFunction(this, name, {
        runtime: lambda.Runtime.NODEJS_22_X,
        entry: lambdaEntry('api', entryFile),
        projectRoot: BACKEND_ROOT,
        depsLockFilePath: BACKEND_LOCK,
        handler: 'handler',
        memorySize: 256,
        timeout: cdk.Duration.seconds(15),
        tracing: lambda.Tracing.ACTIVE, // X-Ray (Operational Excellence pillar)
        environment: commonEnv,
        bundling: { minify: true, sourceMap: true },
        // Logs carry caller ARNs and error bodies; they do not need to live forever (feature-49, audit #15).
        logGroup: new logs.LogGroup(this, `${name}Logs`, { retention: logs.RetentionDays.THREE_MONTHS, removalPolicy: cdk.RemovalPolicy.DESTROY }),
      });

    const usageFn = fn('UsageFn', 'usage.ts');
    const costsFn = fn('CostsFn', 'costs.ts');
    const anomaliesFn = fn('AnomaliesFn', 'anomalies.ts');
    const queriesFn = fn('QueriesFn', 'queries.ts');
    // ProjectsFn gets a longer timeout than the 15s default: the Full (Athena) view polls the
    // query synchronously for up to ~22s; a 15s Lambda timeout killed the invocation mid-poll
    // and the browser surfaced status 0 / "Failed to fetch" (QA finding F-002).
    const projectsFn = new NodejsFunction(this, 'ProjectsFn', {
      runtime: lambda.Runtime.NODEJS_22_X,
      entry: lambdaEntry('api', 'projects.ts'),
      projectRoot: BACKEND_ROOT,
      depsLockFilePath: BACKEND_LOCK,
      handler: 'handler',
      memorySize: 256,
      timeout: cdk.Duration.seconds(28),
      tracing: lambda.Tracing.ACTIVE,
      environment: commonEnv,
      bundling: { minify: true, sourceMap: true },
      logGroup: new logs.LogGroup(this, `ProjectsFnLogs`, { retention: logs.RetentionDays.THREE_MONTHS, removalPolicy: cdk.RemovalPolicy.DESTROY }),
    });
    const quotasFn = fn('QuotasFn', 'quotas.ts');

    // Governance read-only view: budget status + enforcement posture for the dashboard.
    const governanceFn = new NodejsFunction(this, 'GovernanceFn', {
      runtime: lambda.Runtime.NODEJS_22_X,
      entry: lambdaEntry('api', 'governance.ts'),
      projectRoot: BACKEND_ROOT,
      depsLockFilePath: BACKEND_LOCK,
      handler: 'handler',
      memorySize: 256,
      timeout: cdk.Duration.seconds(15),
      tracing: lambda.Tracing.ACTIVE,
      environment: {
        ...commonEnv,
        ACCOUNT_ID: cfg.account,
        BEDROCK_BUDGET_NAME: `bedrock-monthly-${cfg.env}`,
        ENABLE_AUTO_CONTAINMENT: String(cfg.enableAutoContainment),
        BUDGET_ACTION_THRESHOLD_PCT: cfg.enforcement?.budgetActionThresholdPct
          ? String(cfg.enforcement.budgetActionThresholdPct) : '',
      },
      bundling: { minify: true, sourceMap: true },
      logGroup: new logs.LogGroup(this, `GovernanceFnLogs`, { retention: logs.RetentionDays.THREE_MONTHS, removalPolicy: cdk.RemovalPolicy.DESTROY }),
    });
    governanceFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['budgets:ViewBudget', 'budgets:DescribeBudget'],
      resources: [`arn:aws:budgets::${cfg.account}:budget/bedrock-monthly-${cfg.env}`],
    }));

    // DORA metrics: registry (admin-managed repos) + on-read metric computation. Needs the
    // table, permission to kick the collector asynchronously, and the GitHub token (to validate
    // a repo exists when an admin adds it).
    const doraFn = new NodejsFunction(this, 'DoraFn', {
      runtime: lambda.Runtime.NODEJS_22_X,
      entry: lambdaEntry('api', 'dora.ts'),
      projectRoot: BACKEND_ROOT,
      depsLockFilePath: BACKEND_LOCK,
      handler: 'handler',
      memorySize: 512,
      timeout: cdk.Duration.seconds(20),
      tracing: lambda.Tracing.ACTIVE,
      environment: {
        ...commonEnv,
        DORA_COLLECTOR_FUNCTION_NAME: dora.collectorFn.functionName,
        GITHUB_TOKEN_SECRET_NAME: dora.githubSecret.secretName,
        DORA_BACKFILL_DAYS: String(cfg.dora?.backfillDays ?? 180),
      },
      bundling: { minify: true, sourceMap: true },
      logGroup: new logs.LogGroup(this, `DoraFnLogs`, { retention: logs.RetentionDays.THREE_MONTHS, removalPolicy: cdk.RemovalPolicy.DESTROY }),
    });
    tables.dora.grantReadWriteData(doraFn);
    dora.collectorFn.grantInvoke(doraFn);
    dora.githubSecret.grantRead(doraFn);
    // Delivery × Cost join (#13): registry projects + PROJDAY daily cost rollups.
    tables.tenants.grantReadData(doraFn);
    tables.aggregates.grantReadData(doraFn);

    // Project registry (#13): admin-managed project → repos / cost-center / identity hints.
    const projectRegistryFn = new NodejsFunction(this, 'ProjectRegistryFn', {
      runtime: lambda.Runtime.NODEJS_22_X,
      entry: lambdaEntry('api', 'project-registry.ts'),
      projectRoot: BACKEND_ROOT,
      depsLockFilePath: BACKEND_LOCK,
      handler: 'handler',
      memorySize: 256,
      timeout: cdk.Duration.seconds(15),
      tracing: lambda.Tracing.ACTIVE,
      environment: {
        ...commonEnv,
        PROJECTS_SEED_JSON: JSON.stringify(cfg.projects?.seedProjects ?? []),
      },
      bundling: { minify: true, sourceMap: true },
      logGroup: new logs.LogGroup(this, `ProjectRegistryFnLogs`, { retention: logs.RetentionDays.THREE_MONTHS, removalPolicy: cdk.RemovalPolicy.DESTROY }),
    });
    tables.tenants.grantReadWriteData(projectRegistryFn);

    // AI-coding ROI (#14): read-only joins over registry + PROJDAY + DORA — least privilege.
    const roiFn = new NodejsFunction(this, 'RoiFn', {
      runtime: lambda.Runtime.NODEJS_22_X,
      entry: lambdaEntry('api', 'roi.ts'),
      projectRoot: BACKEND_ROOT,
      depsLockFilePath: BACKEND_LOCK,
      handler: 'handler',
      memorySize: 512,
      timeout: cdk.Duration.seconds(20),
      tracing: lambda.Tracing.ACTIVE,
      environment: commonEnv,
      bundling: { minify: true, sourceMap: true },
      logGroup: new logs.LogGroup(this, `RoiFnLogs`, { retention: logs.RetentionDays.THREE_MONTHS, removalPolicy: cdk.RemovalPolicy.DESTROY }),
    });
    tables.tenants.grantReadData(roiFn);
    tables.aggregates.grantReadData(roiFn);
    tables.dora.grantReadData(roiFn);

    // Model-hop latency: reads CloudWatch AWS/Bedrock only — no table grants, since the metrics
    // carry no tenant dimension and the endpoint returns nothing tenant-specific.
    const latencyFn = new NodejsFunction(this, 'LatencyFn', {
      runtime: lambda.Runtime.NODEJS_22_X,
      entry: lambdaEntry('api', 'latency.ts'),
      projectRoot: BACKEND_ROOT,
      depsLockFilePath: BACKEND_LOCK,
      handler: 'handler',
      memorySize: 512,
      timeout: cdk.Duration.seconds(20),
      tracing: lambda.Tracing.ACTIVE,
      environment: commonEnv,
      bundling: { minify: true, sourceMap: true },
      logGroup: new logs.LogGroup(this, `LatencyFnLogs`, { retention: logs.RetentionDays.THREE_MONTHS, removalPolicy: cdk.RemovalPolicy.DESTROY }),
    });
    // Phase 1b: the per-project section reads the tenant's PROJDAY latency rollups and the registry
    // for names. Read-only, same two tables the DORA and ROI functions read. The fleet section
    // still touches no table.
    tables.tenants.grantReadData(latencyFn);
    tables.aggregates.grantReadData(latencyFn);
    latencyFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          'cloudwatch:GetMetricData',
          'cloudwatch:ListMetrics',
          // CloudWatch reports profile-routed traffic under the inference-profile id, so the id has
          // to be resolved back to a model name for the by-model table to be readable. Read-only,
          // and the handler degrades to raw ids if it is denied.
          'bedrock:ListInferenceProfiles',
        ],
        resources: ['*'], // None of these actions supports resource-level permissions.
      }),
    );

    // feature-23: Overview — spend vs prior period, daily series, movers; reads PROJDAY + registry.
    const overviewFn = new NodejsFunction(this, 'OverviewFn', {
      runtime: lambda.Runtime.NODEJS_22_X,
      entry: lambdaEntry('api', 'overview.ts'),
      projectRoot: BACKEND_ROOT,
      depsLockFilePath: BACKEND_LOCK,
      handler: 'handler',
      memorySize: 512,
      timeout: cdk.Duration.seconds(20),
      tracing: lambda.Tracing.ACTIVE,
      environment: commonEnv,
      bundling: { minify: true, sourceMap: true },
      logGroup: new logs.LogGroup(this, `OverviewFnLogs`, { retention: logs.RetentionDays.THREE_MONTHS, removalPolicy: cdk.RemovalPolicy.DESTROY }),
    });
    tables.tenants.grantReadData(overviewFn);
    tables.aggregates.grantReadData(overviewFn);

    // Least-privilege grants.
    tables.aggregates.grantReadData(usageFn);
    tables.aggregates.grantReadData(costsFn);
    tables.tenants.grantReadData(costsFn); // feature-36: resolve profile-ARN-keyed rows to their model at read time
    // Bedrock Mantle counts for the "billed vs logged" block (feature-40): CloudWatch AWS/BedrockMantle, read-only,
    // no resource-level scoping exists for these actions.
    for (const f of [costsFn, overviewFn]) {
      f.addToRolePolicy(new iam.PolicyStatement({ actions: ['cloudwatch:GetMetricData', 'cloudwatch:ListMetrics'], resources: ['*'] }));
    }
    tables.anomalies.grantReadData(anomaliesFn);

    // Functions that run Athena over the raw-log table need: Athena exec, Glue catalog read,
    // read on the source bucket + its KMS key, and read/write on the Athena results bucket.
    const grantAthena = (f: NodejsFunction) => {
      f.addToRolePolicy(new iam.PolicyStatement({
        actions: [
          'athena:StartQueryExecution', 'athena:GetQueryExecution', 'athena:GetQueryResults',
          'athena:StopQueryExecution', 'athena:GetWorkGroup',
        ],
        resources: [`arn:aws:athena:${cfg.region}:${cfg.account}:workgroup/${athena.workgroupName}`],
      }));
      f.addToRolePolicy(new iam.PolicyStatement({
        actions: [
          'glue:GetDatabase', 'glue:GetTable', 'glue:GetTables', 'glue:GetPartition', 'glue:GetPartitions',
        ],
        resources: [
          `arn:aws:glue:${cfg.region}:${cfg.account}:catalog`,
          `arn:aws:glue:${cfg.region}:${cfg.account}:database/token_monitoring_${cfg.env}`,
          `arn:aws:glue:${cfg.region}:${cfg.account}:table/token_monitoring_${cfg.env}/*`,
        ],
      }));
      rawLogBucket.grantRead(f);
      athena.resultsBucket.grantReadWrite(f);
      dataKey.grantEncryptDecrypt(f); // results are SSE-KMS; raw bucket is KMS too
    };
    grantAthena(queriesFn);
    grantAthena(projectsFn);
    curatedBucket.grantRead(projectsFn); // project_mapping CSV lives in the curated bucket
    curatedBucket.grantRead(queriesFn); // byProject template joins the same mapping CSV (F-002)
    tables.tenants.grantReadData(queriesFn); // byProject resolves AIP ARNs via the registry profile cache (F-501)
    // Each started execution is bound to the tenant that started it (QUERY#<tenant>/<id>, TTL 24 h) so GET /v1/queries/{id}
    // never returns another tenant's rows (feature-47).
    tables.aggregates.grant(queriesFn, 'dynamodb:PutItem', 'dynamodb:GetItem');
    tables.aggregates.grantReadData(projectsFn); // #7 fast path reads PROJECT rollups from DynamoDB
    tables.tenants.grantReadData(projectsFn); // #13 registry names/cost centers for fast-path rows

    // quotasFn reads CloudWatch Bedrock metrics + Service Quotas limits (read-only, account-wide).
    quotasFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['cloudwatch:GetMetricData', 'cloudwatch:GetMetricStatistics', 'cloudwatch:ListMetrics', 'servicequotas:ListServiceQuotas'],
      resources: ['*'], // these read-only actions don't support resource-level scoping
    }));

    this.restApi = new apigw.RestApi(this, 'Api', {
      restApiName: `tums-${cfg.env}`,
      deployOptions: {
        tracingEnabled: true, stageName: cfg.env,
        // Stage-wide ceiling (feature-49, audit #6): a viewer in a loop cannot turn the API into an Athena bill.
        throttlingRateLimit: 20, throttlingBurstLimit: 40,
        // Access log per request (who, what, status, latency) — the audit found no request-level audit trail.
        accessLogDestination: new apigw.LogGroupLogDestination(new logs.LogGroup(this, 'ApiAccessLogs', {
          retention: logs.RetentionDays.THREE_MONTHS, removalPolicy: cdk.RemovalPolicy.DESTROY,
        })),
        accessLogFormat: apigw.AccessLogFormat.jsonWithStandardFields({
          caller: true, httpMethod: true, ip: true, protocol: true, requestTime: true, resourcePath: true, responseLength: true, status: true, user: true,
        }),
        // Athena-starting routes get their own, lower, ceiling.
        methodOptions: {
          '/v1/queries/POST': { throttlingRateLimit: 2, throttlingBurstLimit: 5 },
          '/v1/projects/GET': { throttlingRateLimit: 5, throttlingBurstLimit: 10 },
        },
      },
      defaultCorsPreflightOptions: {
        allowOrigins: allowedOrigins ?? apigw.Cors.ALL_ORIGINS, // production: set cfg.api.allowedOrigins
        allowMethods: apigw.Cors.ALL_METHODS,
      },
    });

    // Five or more 5XX in five minutes = something is broken for real users; one page, not a dashboard refresh.
    this.restApi.metricServerError({ period: cdk.Duration.minutes(5), statistic: 'Sum' })
      .createAlarm(this, 'Api5xxAlarm', { threshold: 5, evaluationPeriods: 1, alarmDescription: `TUMS ${cfg.env}: API 5XX ≥ 5 in 5 min`, treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING })
      .addAlarmAction(new cwActions.SnsAction(alertTopic));

    const authorizer = new apigw.CognitoUserPoolsAuthorizer(this, 'Authorizer', {
      cognitoUserPools: [userPool],
    });
    const opts: apigw.MethodOptions = {
      authorizer,
      authorizationType: apigw.AuthorizationType.COGNITO,
    };

    const v1 = this.restApi.root.addResource('v1');
    v1.addResource('usage').addMethod('GET', new apigw.LambdaIntegration(usageFn), opts);
    v1.addResource('costs').addMethod('GET', new apigw.LambdaIntegration(costsFn), opts);
    v1.addResource('anomalies').addMethod('GET', new apigw.LambdaIntegration(anomaliesFn), opts);
    const projects = v1.addResource('projects');
    projects.addMethod('GET', new apigw.LambdaIntegration(projectsFn), opts);
    // Project registry (#13). Reads for any signed-in user; writes require the admin group.
    const registryInt = new apigw.LambdaIntegration(projectRegistryFn);
    const registry = projects.addResource('registry');
    registry.addMethod('GET', registryInt, opts);
    registry.addMethod('POST', registryInt, opts);
    registry.addResource('{id}').addMethod('DELETE', registryInt, opts);
    const regDefaults = registry.addResource('defaults');
    regDefaults.addMethod('GET', registryInt, opts);
    regDefaults.addMethod('PUT', registryInt, opts);

    // ROI (#14). Reads for any signed-in user.
    const roiInt = new apigw.LambdaIntegration(roiFn);
    const roiRes = v1.addResource('roi');
    roiRes.addResource('projects').addMethod('GET', roiInt, opts);
    roiRes.addResource('estimate').addMethod('GET', roiInt, opts);
    v1.addResource('latency').addMethod('GET', new apigw.LambdaIntegration(latencyFn), opts);
    v1.addResource('overview').addMethod('GET', new apigw.LambdaIntegration(overviewFn), opts);
    v1.addResource('quotas').addMethod('GET', new apigw.LambdaIntegration(quotasFn), opts);
    v1.addResource('governance').addMethod('GET', new apigw.LambdaIntegration(governanceFn), opts);
    const queries = v1.addResource('queries');
    queries.addMethod('POST', new apigw.LambdaIntegration(queriesFn), opts);
    queries.addResource('{id}').addMethod('GET', new apigw.LambdaIntegration(queriesFn), opts);

    // DORA metrics (#12). Reads for any signed-in user; repo management requires the Cognito
    // `admin` group (enforced inside the Lambda via the cognito:groups claim).
    const doraInt = new apigw.LambdaIntegration(doraFn);
    const doraRes = v1.addResource('dora');
    const doraRepos = doraRes.addResource('repos');
    doraRepos.addMethod('GET', doraInt, opts);
    doraRepos.addMethod('POST', doraInt, opts);
    const doraRepo = doraRepos.addResource('{owner}').addResource('{name}');
    doraRepo.addMethod('DELETE', doraInt, opts);
    doraRepo.addResource('sync').addMethod('POST', doraInt, opts);
    doraRes.addResource('metrics').addMethod('GET', doraInt, opts);
    doraRes.addResource('overview').addMethod('GET', doraInt, opts);
    doraRes.addResource('projects').addMethod('GET', doraInt, opts); // Delivery × Cost rows (#13)

    new cdk.CfnOutput(this, 'ApiUrl', { value: this.restApi.url });
  }
}
