import * as fs from 'fs';
import * as path from 'path';
import { EnvConfig } from './types';

export { EnvConfig } from './types';

/**
 * Loads the JSON config for the requested environment.
 * Usage: cdk deploy --all --context env=dev  →  loads ./dev.json
 */
export function loadConfig(env: string): EnvConfig {
  const file = path.join(__dirname, `${env}.json`);
  if (!fs.existsSync(file)) {
    throw new Error(
      `Config file not found: ${file}. ` +
        `Copy example.env.json to ${env}.json and fill in your account/region.`,
    );
  }
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8')) as EnvConfig;
  if (!cfg.account || cfg.account === '000000000000') {
    throw new Error(`Set a real "account" in ${file} before deploying.`);
  }
  return cfg;
}
