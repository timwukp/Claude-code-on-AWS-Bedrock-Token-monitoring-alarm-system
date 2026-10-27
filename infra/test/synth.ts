import * as fs from 'fs';
import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import { EnvConfig } from '../lib/config';
import { NetworkStack } from '../lib/stacks/network-stack';
import { DataStack } from '../lib/stacks/data-stack';
import { AutomationStack } from '../lib/stacks/automation-stack';
import { EtlStack } from '../lib/stacks/etl-stack';
import { LakehouseStack } from '../lib/stacks/lakehouse-stack';
import { LoggingStack } from '../lib/stacks/logging-stack';

/** The tracked CI config — the same one `make synth` uses in CI, so tests see what CI sees. */
export const cfg: EnvConfig = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'lib', 'config', 'ci.json'), 'utf8'));

/**
 * Builds the stacks under test. Lambda bundling is skipped (`aws:cdk:bundling-stacks: []`) so a
 * test run does not shell out to esbuild; Docker image assets are only staged, never built.
 */
export function synthApp(overrideCfg: EnvConfig = cfg) {
  const cfg = overrideCfg;
  const app = new cdk.App({ context: { 'aws:cdk:bundling-stacks': [] } });
  const env = { account: cfg.account, region: cfg.region };
  const network = new NetworkStack(app, 'T-Network', { env, cfg });
  const data = new DataStack(app, 'T-Data', { env, cfg });
  const automation = new AutomationStack(app, 'T-Automation', { env, cfg, tables: data.tables });
  const etl = new EtlStack(app, 'T-Etl', {
    env, cfg, vpc: network.vpc, rawLogBucket: data.rawLogBucket, curatedBucket: data.curatedBucket,
    tables: data.tables, alertTopic: automation.alertTopic,
  });
  const lakehouse = new LakehouseStack(app, 'T-Lakehouse', {
    env, cfg, dataKey: data.dataKey, tables: data.tables, alertTopic: automation.alertTopic, curatedBucket: data.curatedBucket,
  });
  const logging = new LoggingStack(app, 'T-Logging', {
    env, cfg, rawLogBucket: data.rawLogBucket,
    bedrockLogGroup: lakehouse.bedrockLogGroup, bedrockLogsRole: lakehouse.bedrockLogsRole, bodiesBucket: lakehouse.bodiesBucket,
  });
  return { app, network, data, automation, etl, lakehouse, logging };
}

/** Docker image asset sources recorded in a stack's asset manifest (platform lives there, not in the template). */
export function dockerImageSources(app: cdk.App, stack: cdk.Stack): Array<{ directory?: string; platform?: string }> {
  const asm = app.synth();
  const manifest = JSON.parse(fs.readFileSync(path.join(asm.directory, `${stack.artifactId}.assets.json`), 'utf8'));
  return Object.values(manifest.dockerImages ?? {}).map((a: any) => a.source);
}
