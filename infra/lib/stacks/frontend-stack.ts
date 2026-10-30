import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as apigw from 'aws-cdk-lib/aws-apigateway';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import { Construct } from 'constructs';
import { EnvConfig } from '../config';

interface Props extends cdk.StackProps {
  cfg: EnvConfig;
  api: apigw.RestApi;
  userPool: cognito.UserPool;
}

/**
 * Static SPA hosting: private S3 bucket + CloudFront with Origin Access Control (no public
 * bucket), WAF, and SPA error routing. (Security + Performance pillars.)
 */
export class FrontendStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: Props) {
    super(scope, id, props);
    const { cfg } = props;

    const siteBucket = new s3.Bucket(this, 'SiteBucket', {
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL, // served only via CloudFront OAC
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // WAF for CloudFront must be in us-east-1; create with AWS managed rule set.
    const webAcl = new wafv2.CfnWebACL(this, 'WebAcl', {
      defaultAction: { allow: {} },
      scope: 'CLOUDFRONT',
      visibilityConfig: { cloudWatchMetricsEnabled: true, metricName: 'tums-waf', sampledRequestsEnabled: true },
      rules: [
        {
          name: 'AWSManagedCommon',
          priority: 1,
          overrideAction: { none: {} },
          statement: { managedRuleGroupStatement: { vendorName: 'AWS', name: 'AWSManagedRulesCommonRuleSet' } },
          visibilityConfig: { cloudWatchMetricsEnabled: true, metricName: 'common', sampledRequestsEnabled: true },
        },
      ],
    });

    // Optional custom domain: when both domainName + certificateArn are configured, serve the
    // dashboard on that domain (cert must be an ACM cert in us-east-1). Otherwise use the
    // default *.cloudfront.net domain.
    const useCustomDomain = !!(cfg.frontend.domainName && cfg.frontend.certificateArn);
    const domainConfig = useCustomDomain
      ? {
          domainNames: [cfg.frontend.domainName!],
          certificate: acm.Certificate.fromCertificateArn(this, 'SiteCert', cfg.frontend.certificateArn!),
        }
      : {};

    // Security headers (feature-47, audit #7). The SPA has no inline scripts and loads nothing from third
    // parties, so a strict CSP fits: scripts/styles/images from this origin, XHR only to the API and Cognito.
    // React's style={{}} needs 'unsafe-inline' for styles only. Report-only until cfg.frontend.cspEnforce.
    const apiOrigin = `https://${props.api.restApiId}.execute-api.${this.region}.amazonaws.com`;
    const csp = [
      "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'", "img-src 'self' data:",
      "font-src 'self'", `connect-src 'self' ${apiOrigin} https://cognito-idp.${this.region}.amazonaws.com`,
      "frame-ancestors 'none'", "base-uri 'self'", "form-action 'self'", "object-src 'none'",
    ].join('; ');
    const enforce = cfg.frontend.cspEnforce === true;
    const headersPolicy = new cloudfront.ResponseHeadersPolicy(this, 'SecurityHeaders', {
      comment: `TUMS security headers (${cfg.env})`,
      securityHeadersBehavior: {
        ...(enforce ? { contentSecurityPolicy: { contentSecurityPolicy: csp, override: true } } : {}),
        strictTransportSecurity: { accessControlMaxAge: cdk.Duration.days(365), includeSubdomains: true, preload: false, override: true },
        contentTypeOptions: { override: true },
        frameOptions: { frameOption: cloudfront.HeadersFrameOption.DENY, override: true },
        referrerPolicy: { referrerPolicy: cloudfront.HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN, override: true },
        xssProtection: { protection: true, modeBlock: true, override: true },
      },
      customHeadersBehavior: {
        customHeaders: [
          { header: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=()', override: true },
          ...(enforce ? [] : [{ header: 'Content-Security-Policy-Report-Only', value: csp, override: true }]),
        ],
      },
    });

    // Viewer access logs (who fetched what, from where) — none existed (feature-49, audit #15). Standard logging needs ACLs.
    const logBucket = new s3.Bucket(this, 'CfLogs', {
      encryption: s3.BucketEncryption.S3_MANAGED, enforceSSL: true, blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_PREFERRED, accessControl: s3.BucketAccessControl.LOG_DELIVERY_WRITE,
      lifecycleRules: [{ expiration: cdk.Duration.days(90), abortIncompleteMultipartUploadAfter: cdk.Duration.days(7) }],
      removalPolicy: cdk.RemovalPolicy.DESTROY, autoDeleteObjects: true,
    });

    const distribution = new cloudfront.Distribution(this, 'Distribution', {
      defaultRootObject: 'index.html',
      enableLogging: true, logBucket, logFilePrefix: 'cloudfront/',
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(siteBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        responseHeadersPolicy: headersPolicy,
      },
      webAclId: webAcl.attrArn,
      errorResponses: [
        { httpStatus: 403, responseHttpStatus: 200, responsePagePath: '/index.html' },
        { httpStatus: 404, responseHttpStatus: 200, responsePagePath: '/index.html' },
      ],
      comment: `Token Usage Monitoring dashboard (${cfg.env})`,
      ...domainConfig,
    });

    new cdk.CfnOutput(this, 'SiteBucketName', { value: siteBucket.bucketName });
    new cdk.CfnOutput(this, 'DistributionDomainName', { value: distribution.distributionDomainName });
    new cdk.CfnOutput(this, 'DistributionId', { value: distribution.distributionId });
  }
}
