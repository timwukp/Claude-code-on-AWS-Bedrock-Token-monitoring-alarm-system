#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { loadConfig } from '../lib/config';
import { NetworkStack } from '../lib/stacks/network-stack';
import { DataStack } from '../lib/stacks/data-stack';
import { LoggingStack } from '../lib/stacks/logging-stack';
import { AuthStack } from '../lib/stacks/auth-stack';
import { ApiStack } from '../lib/stacks/api-stack';
import { AutomationStack } from '../lib/stacks/automation-stack';
import { EtlStack } from '../lib/stacks/etl-stack';
import { DoraStack } from '../lib/stacks/dora-stack';
import { ProjectsStack } from '../lib/stacks/projects-stack';
import { FrontendStack } from '../lib/stacks/frontend-stack';
import { LakehouseStack } from '../lib/stacks/lakehouse-stack';

const app = new cdk.App();

const envName = app.node.tryGetContext('env') ?? 'dev';
const cfg = loadConfig(envName);
const env = { account: cfg.account, region: cfg.region };
const prefix = `Tums-${cfg.env}`; // Token Usage Monitoring System

// Independently deployable stacks → small blast radius (Operational Excellence pillar).
const network = new NetworkStack(app, `${prefix}-Network`, { env, cfg });
const data = new DataStack(app, `${prefix}-Data`, { env, cfg });
const automation = new AutomationStack(app, `${prefix}-Automation`, { env, cfg, tables: data.tables });

// Lakehouse (bronze/silver/gold on S3 Tables) — created before Logging because Bedrock's CloudWatch
// Logs destination and the large-body bucket live here.
const lakehouse = new LakehouseStack(app, `${prefix}-Lakehouse`, {
  env, cfg, dataKey: data.dataKey, tables: data.tables, alertTopic: automation.alertTopic, curatedBucket: data.curatedBucket,
  athena: data.athena,
});
const logging = new LoggingStack(app, `${prefix}-Logging`, {
  env, cfg, rawLogBucket: data.rawLogBucket,
  bedrockLogGroup: lakehouse.bedrockLogGroup, bedrockLogsRole: lakehouse.bedrockLogsRole, bodiesBucket: lakehouse.bodiesBucket,
});
const auth = new AuthStack(app, `${prefix}-Auth`, { env, cfg, alertTopic: automation.alertTopic });

// Project cost attribution: tagged application inference profiles + opt-in enforcement (#13).
new ProjectsStack(app, `${prefix}-Projects`, { env, cfg });

// DORA collector + GitHub token secret (independent of the Bedrock-log ETL path).
const dora = new DoraStack(app, `${prefix}-Dora`, { env, cfg, tables: data.tables });

const api = new ApiStack(app, `${prefix}-Api`, {
  env, cfg, userPool: auth.userPool, tables: data.tables, athena: data.athena,
  rawLogBucket: data.rawLogBucket, curatedBucket: data.curatedBucket, dataKey: data.dataKey, alertTopic: automation.alertTopic,
  dora: { collectorFn: dora.collectorFn, githubSecret: dora.githubSecret },
});

new EtlStack(app, `${prefix}-Etl`, {
  env, cfg, vpc: network.vpc, rawLogBucket: data.rawLogBucket,
  curatedBucket: data.curatedBucket, tables: data.tables, alertTopic: automation.alertTopic,
});

new FrontendStack(app, `${prefix}-Frontend`, { env, cfg, api: api.restApi, userPool: auth.userPool });

cdk.Tags.of(app).add('project', 'token-usage-monitoring');
cdk.Tags.of(app).add('environment', cfg.env);
