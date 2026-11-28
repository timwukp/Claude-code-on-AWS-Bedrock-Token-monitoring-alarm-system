import * as fs from 'fs';
import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import { Template } from 'aws-cdk-lib/assertions';
import { cfg, synthApp } from './synth';
import {
  BROKER_FILES, CI_AGENT_ROOT, CI_INVOKE_POLICY, LOCK_KEY, QA_BROKER_FUNCTION, QA_BROKER_ROLE, QaBrokerStack,
} from '../lib/stacks/qa-broker-stack';

/* eslint-disable @typescript-eslint/no-explicit-any -- CloudFormation JSON */

/**
 * feature-53: the QA reset broker's deploy path. The role must match IAM package items 2-3 exactly. Every action and
 * resource is listed here, so a widened grant fails this file before it reaches an account.
 */
describe('QaBrokerStack (feature-53)', () => {
  const { app, qaBroker } = synthApp();
  const t = Template.fromStack(qaBroker);
  const qb = cfg.qaBroker!;
  const policies = () => Object.values(t.findResources('AWS::IAM::Policy')) as Array<{ Properties: any }>;
  const statements = (p: { Properties: any }) => p.Properties.PolicyDocument.Statement as any[];
  const roleRef = (p: { Properties: any }) => JSON.stringify(p.Properties.Roles);
  const brokerRoleId = Object.keys(t.findResources('AWS::IAM::Role'))[0];

  it('creates one python3.12 function with the name the workflow calls, 30 s, its own log group with finite retention', () => {
    t.resourceCountIs('AWS::Lambda::Function', 1);
    const fn = Object.values(t.findResources('AWS::Lambda::Function'))[0] as any;
    expect(fn.Properties).toMatchObject({
      FunctionName: QA_BROKER_FUNCTION, Runtime: 'python3.12', Handler: 'qa_reset_broker.lambda_handler', Timeout: 30, MemorySize: 256,
    });
    expect(QA_BROKER_FUNCTION).toBe('qa-login-reset');
    const groups = t.findResources('AWS::Logs::LogGroup') as Record<string, any>;
    const ref = fn.Properties.LoggingConfig?.LogGroup?.Ref;
    expect(groups[ref]?.Properties.RetentionInDays).toBe(90);
  });

  it('configures the broker from the env file: the pool from AuthStack, the default lease bucket, the logins map', () => {
    const fn = Object.values(t.findResources('AWS::Lambda::Function'))[0] as any;
    const env = fn.Properties.Environment.Variables;
    expect(Object.keys(env).sort()).toEqual(['QA_BROKER_LOCK_BUCKET', 'QA_BROKER_SECRET_MAP', 'QA_BROKER_USER_POOL_ID']);
    expect(env.QA_BROKER_USER_POOL_ID).toEqual({ 'Fn::Select': [1, { 'Fn::Split': ['/', { 'Fn::ImportValue': expect.stringMatching(/UserPool.*Arn/) }] }] });
    expect(env.QA_BROKER_LOCK_BUCKET).toBe(`token-monitor-qa-reports-${cfg.account}`);
    expect(JSON.parse(env.QA_BROKER_SECRET_MAP)).toEqual({
      viewer: { secretId: qb.logins.viewer.secretName, username: qb.logins.viewer.username },
      admin: { secretId: qb.logins.admin.secretName, username: qb.logins.admin.username },
    });
  });

  it('the role trusts Lambda in this account only', () => {
    t.hasResourceProperties('AWS::IAM::Role', {
      RoleName: QA_BROKER_ROLE,
      AssumeRolePolicyDocument: {
        Statement: [{ Effect: 'Allow', Action: 'sts:AssumeRole', Principal: { Service: 'lambda.amazonaws.com' },
          Condition: { StringEquals: { 'aws:SourceAccount': cfg.account } } }],
        Version: '2012-10-17',
      },
    });
    const role = Object.values(t.findResources('AWS::IAM::Role'))[0] as any;
    expect(role.Properties.ManagedPolicyArns).toBeUndefined(); // no AWSLambdaBasicExecutionRole or anything else
    expect(role.Properties.Policies).toBeUndefined();
  });

  it('the role can do exactly this and nothing more (IAM package item 2)', () => {
    const mine = policies().filter((p) => roleRef(p).includes(brokerRoleId));
    expect(mine).toHaveLength(1);
    const got = statements(mine[0]).map((s) => ({ sid: s.Sid, actions: [s.Action].flat().sort(), resources: JSON.stringify(s.Resource) }));
    const bySid = Object.fromEntries(got.map((g) => [g.sid ?? 'logs', g]));
    expect(Object.keys(bySid).sort()).toEqual(['ReadTheLease', 'ResetOnlyInThisPool', 'TheQaLoginSecrets', 'logs']);
    expect(bySid.ResetOnlyInThisPool.actions).toEqual(['cognito-idp:AdminSetUserPassword', 'cognito-idp:AdminUserGlobalSignOut']);
    expect(bySid.ResetOnlyInThisPool.resources).toMatch(/Fn::ImportValue/); // the pool ARN, not "*"
    expect(bySid.TheQaLoginSecrets.actions).toEqual(['secretsmanager:GetSecretValue', 'secretsmanager:PutSecretValue', 'secretsmanager:UpdateSecretVersionStage']);
    for (const l of Object.values(qb.logins)) expect(bySid.TheQaLoginSecrets.resources).toContain(`:secret:${l.secretName}-??????`);
    expect(JSON.parse(bySid.TheQaLoginSecrets.resources)).toHaveLength(Object.keys(qb.logins).length);
    expect(bySid.ReadTheLease.actions).toEqual(['s3:GetObject']);
    expect(bySid.ReadTheLease.resources).toContain(`:s3:::token-monitor-qa-reports-${cfg.account}/${LOCK_KEY}`);
    expect(bySid.logs.actions).toEqual(['logs:CreateLogStream', 'logs:PutLogEvents']);
    for (const g of got) expect(g.resources).not.toBe('"*"');
  });

  it('imports only the pool-ARN export that AuthStack already has, so deploying it does not touch AuthStack', () => {
    const imports = new Set<string>();
    const walk = (x: any): void => {
      if (Array.isArray(x)) x.forEach(walk);
      else if (x && typeof x === 'object') for (const [k, v] of Object.entries(x)) (k === 'Fn::ImportValue' ? imports.add(String(v)) : walk(v));
    };
    walk(t.toJSON());
    expect([...imports]).toEqual([expect.stringMatching(/:ExportsOutputFnGetAttUserPool[0-9A-F]+Arn[0-9A-F]+$/)]);
  });

  it('the read-only verify script names the same function, roles and lease key', () => {
    const sh = fs.readFileSync(path.join(__dirname, '..', '..', 'scripts', 'verify-qa-broker.sh'), 'utf8');
    const v = (name: string) => sh.match(new RegExp(`^${name}=(\\S+)`, 'm'))?.[1];
    expect([v('FN'), v('BROKER_ROLE'), v('CI_ROLE'), v('LOCK_KEY')]).toEqual([QA_BROKER_FUNCTION, QA_BROKER_ROLE, qb.ciRoleName, LOCK_KEY]);
    expect([v('VIEWER_SECRET'), v('ADMIN_SECRET')]).toEqual([qb.logins.viewer.secretName, qb.logins.admin.secretName]);
  });

  it('the lease key is the lock spec\'s key', () => {
    const spec = JSON.parse(fs.readFileSync(path.join(CI_AGENT_ROOT, 'harness_lock_spec.json'), 'utf8'));
    expect(LOCK_KEY).toBe(spec.key);
    expect(LOCK_KEY).toBe('locks/ui-harness.json');
  });

  it('attaches ONE named policy to the CI role: invoke this function (IAM package item 3)', () => {
    const ci = policies().filter((p) => p.Properties.PolicyName === CI_INVOKE_POLICY);
    expect(ci).toHaveLength(1);
    expect(ci[0].Properties.Roles).toEqual([qb.ciRoleName]);
    const st = statements(ci[0]);
    expect(st).toHaveLength(1);
    expect(st[0]).toMatchObject({ Sid: 'InvokeTheResetBroker', Effect: 'Allow', Action: 'lambda:InvokeFunction' });
    expect(JSON.stringify(st[0].Resource)).toMatch(/Fn::GetAtt.*Broker.*Arn/);
    expect(policies()).toHaveLength(2); // the broker's own policy and this one: no other role is touched
  });

  it('the config\'s CI role is the role the UI QA workflow assumes', () => {
    const wf = fs.readFileSync(path.join(__dirname, '..', '..', '.github', 'workflows', 'ui-qa-agent.yml'), 'utf8');
    const roles = new Set([...wf.matchAll(/role-to-assume: .*:role\/([\w+=,.@-]+)/g)].map((m) => m[1]));
    expect([...roles]).toEqual([qb.ciRoleName]);
    expect(wf.match(/role-to-assume:/g)?.length).toBeGreaterThanOrEqual(2); // the parser saw every step, not just one
    const example = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'lib', 'config', 'example.env.json'), 'utf8'));
    expect(example.qaBroker.ciRoleName).toBe(qb.ciRoleName);
  });

  it('ships exactly the broker, the lease module and their specs, no tests and nothing else from ci-agent/', () => {
    const asm = app.synth();
    const manifest = JSON.parse(fs.readFileSync(path.join(asm.directory, `${qaBroker.artifactId}.assets.json`), 'utf8'));
    const fn = Object.values(t.findResources('AWS::Lambda::Function'))[0] as any;
    const key: string = fn.Properties.Code.S3Key;
    const asset = manifest.files[key.replace(/\.zip$/, '')];
    const files = fs.readdirSync(path.join(asm.directory, asset.source.path)).sort();
    expect(files).toEqual([...BROKER_FILES].sort());
    for (const f of BROKER_FILES) expect(fs.existsSync(path.join(CI_AGENT_ROOT, f))).toBe(true);
  });

  describe('refuses an env file it cannot deploy correctly', () => {
    const build = (qaBroker: any) => {
      const app2 = new cdk.App({ context: { 'aws:cdk:bundling-stacks': [] } });
      const env = { account: cfg.account, region: cfg.region };
      const pool = new cdk.Stack(app2, 'P', { env });
      return () => new QaBrokerStack(app2, 'Q', { env, cfg: { ...cfg, qaBroker }, userPool: new cognito.UserPool(pool, 'U') });
    };
    it('without qaBroker', () => expect(build(undefined)).toThrow(/needs cfg.qaBroker/));
    it('with no logins', () => expect(build({ ciRoleName: 'R', logins: {} })).toThrow(/logins is empty/));
    it('with a login missing its username', () => expect(build({ ciRoleName: 'R', logins: { viewer: { secretName: 's', username: '' } } })).toThrow(/needs secretName and username/));
  });
});
