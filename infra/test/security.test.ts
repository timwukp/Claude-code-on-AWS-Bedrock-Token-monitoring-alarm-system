import { Match, Template } from 'aws-cdk-lib/assertions';
import { cfg, synthApp } from './synth';

/**
 * Security invariants from the 2026-10-28 audit (feature-47). Each test names the property that, when it
 * regressed silently, produced a finding — so a future change that drops it fails here, not in production.
 */
describe('security invariants', () => {
  const stacks = synthApp();
  const t = (s: keyof typeof stacks) => Template.fromStack(stacks[s] as any); // eslint-disable-line @typescript-eslint/no-explicit-any -- cdk.Stack union

  describe('browser surface (audit #7)', () => {
    const fe = t('frontend');
    it('CloudFront sends HSTS, nosniff, frame DENY, referrer policy and a CSP', () => {
      fe.hasResourceProperties('AWS::CloudFront::ResponseHeadersPolicy', {
        ResponseHeadersPolicyConfig: Match.objectLike({
          SecurityHeadersConfig: Match.objectLike({
            StrictTransportSecurity: Match.objectLike({ AccessControlMaxAgeSec: 31536000, IncludeSubdomains: true }),
            ContentTypeOptions: Match.objectLike({ Override: true }),
            FrameOptions: Match.objectLike({ FrameOption: 'DENY' }),
            ReferrerPolicy: Match.objectLike({ ReferrerPolicy: 'strict-origin-when-cross-origin' }),
          }),
          CustomHeadersConfig: Match.objectLike({
            Items: Match.arrayWith([
              Match.objectLike({ Header: 'Permissions-Policy' }),
              // The value is an Fn::Join (the API origin is a cross-stack token): match the literal pieces.
              Match.objectLike({ Header: 'Content-Security-Policy-Report-Only', Value: Match.objectLike({ 'Fn::Join': ['', Match.arrayWith([Match.stringLikeRegexp("^default-src 'self'; script-src 'self'"), Match.stringLikeRegexp("frame-ancestors 'none'")])] }) }),
            ]),
          }),
        }),
      });
      fe.hasResourceProperties('AWS::CloudFront::Distribution', {
        DistributionConfig: Match.objectLike({ DefaultCacheBehavior: Match.objectLike({ ResponseHeadersPolicyId: Match.anyValue(), ViewerProtocolPolicy: 'redirect-to-https' }) }),
      });
    });
    it('enforces the CSP when the config says so', () => {
      const enforced = Template.fromStack(synthApp({ ...cfg, frontend: { ...cfg.frontend, cspEnforce: true } }).frontend);
      enforced.hasResourceProperties('AWS::CloudFront::ResponseHeadersPolicy', {
        ResponseHeadersPolicyConfig: Match.objectLike({ SecurityHeadersConfig: Match.objectLike({ ContentSecurityPolicy: Match.objectLike({ ContentSecurityPolicy: Match.objectLike({ 'Fn::Join': ['', Match.arrayWith([Match.stringLikeRegexp("script-src 'self'")])] }) }) }) }),
      });
    });
    it('the site bucket blocks public access and the distribution is behind a WAF', () => {
      fe.hasResourceProperties('AWS::S3::Bucket', { PublicAccessBlockConfiguration: { BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true } });
      fe.hasResourceProperties('AWS::CloudFront::Distribution', { DistributionConfig: Match.objectLike({ WebACLId: Match.anyValue() }) });
    });
  });

  describe('Cognito (audit #12)', () => {
    const auth = t('auth');
    it('no self sign-up, immutable tenantId, threat protection, deletion protection, 12-char policy', () => {
      auth.hasResourceProperties('AWS::Cognito::UserPool', Match.objectLike({
        AdminCreateUserConfig: Match.objectLike({ AllowAdminCreateUserOnly: true }),
        DeletionProtection: 'ACTIVE',
        UserPoolAddOns: { AdvancedSecurityMode: 'ENFORCED' },
        Policies: Match.objectLike({ PasswordPolicy: Match.objectLike({ MinimumLength: 12, RequireSymbols: true }) }),
        Schema: Match.arrayWith([Match.objectLike({ Name: 'tenantId', Mutable: false })]),
      }));
    });
    it('web client: short tokens, no enumeration, no OAuth, no client secret', () => {
      auth.hasResourceProperties('AWS::Cognito::UserPoolClient', Match.objectLike({
        RefreshTokenValidity: 1440, IdTokenValidity: 60, AccessTokenValidity: 60,
        TokenValidityUnits: { AccessToken: 'minutes', IdToken: 'minutes', RefreshToken: 'minutes' },
        PreventUserExistenceErrors: 'ENABLED',
        AllowedOAuthFlowsUserPoolClient: false,
        GenerateSecret: Match.absent(),
      }));
    });
  });

  describe('API Gateway (audit #1/#6 groundwork)', () => {
    const api = t('api');
    it('every non-OPTIONS method requires the Cognito authorizer', () => {
      const methods = api.findResources('AWS::ApiGateway::Method');
      const open = Object.entries(methods).filter(([, m]) => m.Properties.HttpMethod !== 'OPTIONS' && m.Properties.AuthorizationType !== 'COGNITO_USER_POOLS');
      expect(open.map(([id]) => id)).toEqual([]);
    });
    it('every function is on a current Node.js runtime', () => {
      for (const s of ['api', 'etl', 'automation', 'dora', 'lakehouse'] as const) {
        const fns = Object.values(t(s).findResources('AWS::Lambda::Function')) as Array<{ Properties: { Runtime?: string } }>;
        for (const f of fns) if (f.Properties.Runtime) expect(f.Properties.Runtime).toMatch(/^nodejs2[2-9]\.x$|^python3\.1[2-9]$/);
      }
    });
    it('refuses to synth a non-dev environment without allowedOrigins (CORS cannot default to *)', () => {
      expect(() => synthApp({ ...cfg, env: 'prod', api: { ...cfg.api, allowedOrigins: undefined } } as typeof cfg).app.synth()).toThrow(/allowedOrigins/);
    });
  });

  describe('data stores (audit #2/#13)', () => {
    const data = t('data');
    it('tables carry the TTL attribute the processed-markers and query bindings rely on, and deletion protection', () => {
      const tables = Object.values(data.findResources('AWS::DynamoDB::Table')) as Array<{ Properties: Record<string, unknown> }>;
      expect(tables.length).toBeGreaterThanOrEqual(4);
      for (const tb of tables) {
        expect(tb.Properties.TimeToLiveSpecification).toEqual({ AttributeName: 'expiresAt', Enabled: true });
        expect(tb.Properties.DeletionProtectionEnabled).toBe(true);
        expect(tb.Properties.PointInTimeRecoverySpecification).toEqual({ PointInTimeRecoveryEnabled: true });
      }
    });
    it('every bucket in Data blocks public access and enforces TLS', () => {
      const buckets = Object.values(data.findResources('AWS::S3::Bucket')) as Array<{ Properties: Record<string, unknown> }>;
      for (const b of buckets) expect(b.Properties.PublicAccessBlockConfiguration).toEqual({ BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true });
      const policies = Object.values(data.findResources('AWS::S3::BucketPolicy')) as Array<{ Properties: { PolicyDocument: { Statement: Array<{ Condition?: Record<string, unknown> }> } } }>;
      expect(policies.some((p) => p.Properties.PolicyDocument.Statement.some((s) => JSON.stringify(s.Condition ?? {}).includes('aws:SecureTransport')))).toBe(true);
    });
  });

  describe('limits, retention and alarms (audit #6/#15, feature-49)', () => {
    it('the API stage is throttled, access-logged, and the Athena-starting routes are throttled harder', () => {
      t('api').hasResourceProperties('AWS::ApiGateway::Stage', Match.objectLike({
        MethodSettings: Match.arrayWith([
          Match.objectLike({ HttpMethod: '*', ResourcePath: '/*', ThrottlingRateLimit: 20, ThrottlingBurstLimit: 40 }),
          Match.objectLike({ HttpMethod: 'POST', ResourcePath: '/~1v1~1queries', ThrottlingRateLimit: 2, ThrottlingBurstLimit: 5 }),
        ]),
        AccessLogSetting: Match.objectLike({ DestinationArn: Match.anyValue() }),
      }));
    });
    it('a single Athena query cannot scan more than 10 GB', () => {
      t('data').hasResourceProperties('AWS::Athena::WorkGroup', Match.objectLike({
        WorkGroupConfiguration: Match.objectLike({ BytesScannedCutoffPerQuery: 10 * 1024 ** 3, EnforceWorkGroupConfiguration: true }),
      }));
    });
    it('every versioned bucket expires non-current versions and aborts stale multipart uploads', () => {
      const buckets = Object.values(t('data').findResources('AWS::S3::Bucket')) as Array<{ Properties: any }>; // eslint-disable-line @typescript-eslint/no-explicit-any -- CloudFormation JSON
      for (const b of buckets) {
        const rules = b.Properties.LifecycleConfiguration?.Rules ?? [];
        expect(rules.some((r: any) => r.NoncurrentVersionExpiration?.NoncurrentDays === 1 && r.AbortIncompleteMultipartUpload?.DaysAfterInitiation === 7)).toBe(true); // eslint-disable-line @typescript-eslint/no-explicit-any
      }
    });
    it('every Lambda in the API/Etl/Automation/Dora stacks writes to a log group with finite retention', () => {
      for (const s of ['api', 'etl', 'automation', 'dora'] as const) {
        const tpl = t(s);
        const fns = Object.values(tpl.findResources('AWS::Lambda::Function')) as Array<{ Properties: any }>; // eslint-disable-line @typescript-eslint/no-explicit-any
        const groups = Object.values(tpl.findResources('AWS::Logs::LogGroup')) as Array<{ Properties: any }>; // eslint-disable-line @typescript-eslint/no-explicit-any
        // Our own functions use `index.handler`; CDK's custom-resource providers (framework.onEvent, auto-delete) are exempt.
        const appFns = Object.entries(tpl.findResources('AWS::Lambda::Function')).filter(([, f]: any) => f.Properties.Runtime?.startsWith('nodejs') && f.Properties.Handler === 'index.handler'); // eslint-disable-line @typescript-eslint/no-explicit-any
        const missing = appFns.filter(([, f]: any) => !f.Properties.LoggingConfig?.LogGroup).map(([id]) => id); // eslint-disable-line @typescript-eslint/no-explicit-any
        expect(missing).toEqual([]);
        // …and the group each function points at has a finite retention.
        const allGroups = tpl.findResources('AWS::Logs::LogGroup') as Record<string, { Properties: any }>; // eslint-disable-line @typescript-eslint/no-explicit-any
        for (const [id, f] of appFns as Array<[string, any]>) { // eslint-disable-line @typescript-eslint/no-explicit-any
          const ref = f.Properties.LoggingConfig.LogGroup?.Ref;
          expect(ref && allGroups[ref]?.Properties.RetentionInDays).toBeTruthy();
          void id;
        }
        void fns; void groups;
      }
    });
    it('alarms exist for API 5XX, the two Etl jobs, the anomaly responder and Cognito sign-in throttles', () => {
      const names = (s: 'api' | 'etl' | 'automation' | 'auth') => Object.keys(t(s).findResources('AWS::CloudWatch::Alarm'));
      expect(names('api').some((n) => n.startsWith('Api5xxAlarm'))).toBe(true);
      expect(names('etl').some((n) => n.startsWith('AggregatorErrors'))).toBe(true);
      expect(names('etl').some((n) => n.startsWith('BillCollectorErrors'))).toBe(true);
      expect(names('automation').some((n) => n.startsWith('AnomalyResponseErrors'))).toBe(true);
      expect(names('auth').some((n) => n.startsWith('SignInThrottlesAlarm'))).toBe(true);
    });
    it('CloudFront writes viewer logs', () => {
      t('frontend').hasResourceProperties('AWS::CloudFront::Distribution', { DistributionConfig: Match.objectLike({ Logging: Match.objectLike({ Prefix: 'cloudfront/' }) }) });
    });
    it('containment refuses a config where a target is also never-contain, or is not a role', () => {
      const base = { ...cfg, enableAutoContainment: true, enforcement: { budgetActionThresholdPct: 90, budgetActionRoleArns: ['arn:aws:iam::111122223333:role/Target'], neverContainArns: ['arn:aws:sts::111122223333:assumed-role/Target/s'] } } as typeof cfg;
      expect(() => synthApp(base).app.synth()).toThrow(/both a containment target and in neverContainArns/);
      const user = { ...cfg, enableAutoContainment: true, enforcement: { budgetActionThresholdPct: 90, budgetActionRoleArns: ['arn:aws:iam::111122223333:user/alice'] } } as typeof cfg;
      expect(() => synthApp(user).app.synth()).toThrow(/not an IAM role ARN/);
    });
  });

  describe('IAM wildcards are confined to actions that cannot be scoped', () => {
    // Actions AWS documents as not resource-scopable, plus ecs:StopTask which CDK's EcsRunTask(.sync) integration emits on `*`. Anything else on `*` fails.
    const SCOPELESS = /^(cloudwatch:(GetMetricData|ListMetrics|GetMetricStatistics)|ce:GetCostAndUsage|servicequotas:ListServiceQuotas|bedrock:(ListInferenceProfiles|ListFoundationModels)|xray:(Put.*|GetSamplingRules|GetSamplingTargets)|ecr:GetAuthorizationToken|lakeformation:GetDataAccess|ecs:(DescribeTasks|StopTask)|sts:GetCallerIdentity|pricing:GetProducts)$/;
    it.each(['api', 'etl', 'automation', 'dora'] as const)('%s: no write/admin action on Resource "*"', (s) => {
      const bad: string[] = [];
      const docs: Array<[string, any]> = []; // eslint-disable-line @typescript-eslint/no-explicit-any -- CloudFormation JSON
      for (const [id, p] of Object.entries(t(s).findResources('AWS::IAM::Policy'))) docs.push([id, (p as any).Properties.PolicyDocument]);
      for (const [id, p] of Object.entries(t(s).findResources('AWS::IAM::ManagedPolicy'))) docs.push([id, (p as any).Properties.PolicyDocument]);
      for (const [id, r] of Object.entries(t(s).findResources('AWS::IAM::Role'))) for (const ip of (r as any).Properties.Policies ?? []) docs.push([`${id}/${ip.PolicyName}`, ip.PolicyDocument]);
      for (const [id, doc] of docs) {
        for (const st of doc.Statement) {
          const res = Array.isArray(st.Resource) ? st.Resource : [st.Resource];
          if (!res.includes('*')) continue;
          for (const a of Array.isArray(st.Action) ? st.Action : [st.Action]) if (!SCOPELESS.test(a)) bad.push(`${id}: ${a}`);
        }
      }
      expect(bad).toEqual([]);
    });
  });
});
