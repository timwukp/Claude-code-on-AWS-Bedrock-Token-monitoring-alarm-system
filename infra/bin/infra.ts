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
import { FrontendStack } from '../lib/stacks/frontend-stack';

const app = new cdk.App();

const envName = app.node.tryGetContext('env') ?? 'dev';
const cfg = loadConfig(envName);
const env = { account: cfg.account, region: cfg.region };
const prefix = `Tums-${cfg.env}`; // Token Usage Monitoring System

// Independently deployable stacks → small blast radius (Operational Excellence pillar).
const network = new NetworkStack(app, `${prefix}-Network`, { env, cfg });
const data = new DataStack(app, `${prefix}-Data`, { env, cfg });
const logging = new LoggingStack(app, `${prefix}-Logging`, { env, cfg, rawLogBucket: data.rawLogBucket });
const auth = new AuthStack(app, `${prefix}-Auth`, { env, cfg });

const api = new ApiStack(app, `${prefix}-Api`, {
  env, cfg, userPool: auth.userPool, tables: data.tables, athena: data.athena,
  rawLogBucket: data.rawLogBucket, curatedBucket: data.curatedBucket, dataKey: data.dataKey,
});

new AutomationStack(app, `${prefix}-Automation`, { env, cfg, tables: data.tables });

new EtlStack(app, `${prefix}-Etl`, {
  env, cfg, vpc: network.vpc, rawLogBucket: data.rawLogBucket,
  curatedBucket: data.curatedBucket, tables: data.tables,
});

new FrontendStack(app, `${prefix}-Frontend`, { env, cfg, api: api.restApi, userPool: auth.userPool });

cdk.Tags.of(app).add('project', 'token-usage-monitoring');
cdk.Tags.of(app).add('environment', cfg.env);
