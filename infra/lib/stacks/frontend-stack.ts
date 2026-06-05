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

    const distribution = new cloudfront.Distribution(this, 'Distribution', {
      defaultRootObject: 'index.html',
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(siteBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
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
