import * as cdk from 'aws-cdk-lib';
import * as apigw from 'aws-cdk-lib/aws-apigateway';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as kms from 'aws-cdk-lib/aws-kms';
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
    const { cfg, userPool, tables, athena, rawLogBucket, curatedBucket, dataKey } = props;

    const commonEnv = {
      AGGREGATES_TABLE: tables.aggregates.tableName,
      ANOMALIES_TABLE: tables.anomalies.tableName,
      TENANTS_TABLE: tables.tenants.tableName,
      ATHENA_WORKGROUP: athena.workgroupName,
      GLUE_DATABASE: `token_monitoring_${cfg.env}`,
    };

    const fn = (name: string, entryFile: string) =>
      new NodejsFunction(this, name, {
        runtime: lambda.Runtime.NODEJS_20_X,
        entry: lambdaEntry('api', entryFile),
        projectRoot: BACKEND_ROOT,
        depsLockFilePath: BACKEND_LOCK,
        handler: 'handler',
        memorySize: 256,
        timeout: cdk.Duration.seconds(15),
        tracing: lambda.Tracing.ACTIVE, // X-Ray (Operational Excellence pillar)
        environment: commonEnv,
        bundling: { minify: true, sourceMap: true },
      });

    const usageFn = fn('UsageFn', 'usage.ts');
    const costsFn = fn('CostsFn', 'costs.ts');
    const anomaliesFn = fn('AnomaliesFn', 'anomalies.ts');
    const queriesFn = fn('QueriesFn', 'queries.ts');
    const projectsFn = fn('ProjectsFn', 'projects.ts');
    const quotasFn = fn('QuotasFn', 'quotas.ts');

    // Least-privilege grants.
    tables.aggregates.grantReadData(usageFn);
    tables.aggregates.grantReadData(costsFn);
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

    // quotasFn reads CloudWatch Bedrock metrics + Service Quotas limits (read-only, account-wide).
    quotasFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['cloudwatch:GetMetricStatistics', 'servicequotas:ListServiceQuotas'],
      resources: ['*'], // these read-only actions don't support resource-level scoping
    }));

    this.restApi = new apigw.RestApi(this, 'Api', {
      restApiName: `tums-${cfg.env}`,
      deployOptions: { tracingEnabled: true, stageName: cfg.env },
      defaultCorsPreflightOptions: {
        allowOrigins: apigw.Cors.ALL_ORIGINS, // TODO: restrict to the CloudFront domain
        allowMethods: apigw.Cors.ALL_METHODS,
      },
    });

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
    v1.addResource('projects').addMethod('GET', new apigw.LambdaIntegration(projectsFn), opts);
    v1.addResource('quotas').addMethod('GET', new apigw.LambdaIntegration(quotasFn), opts);
    const queries = v1.addResource('queries');
    queries.addMethod('POST', new apigw.LambdaIntegration(queriesFn), opts);
    queries.addResource('{id}').addMethod('GET', new apigw.LambdaIntegration(queriesFn), opts);

    new cdk.CfnOutput(this, 'ApiUrl', { value: this.restApi.url });
  }
}
