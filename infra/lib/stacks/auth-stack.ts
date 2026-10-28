import * as cdk from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import { Construct } from 'constructs';
import { EnvConfig } from '../config';

interface Props extends cdk.StackProps {
  cfg: EnvConfig;
}

/**
 * Cognito user pool for dashboard authentication. The API Gateway authorizer validates the
 * JWT; a custom `tenantId` attribute scopes every request to one tenant (Security pillar,
 * multi-tenant isolation).
 */
export class AuthStack extends cdk.Stack {
  public readonly userPool: cognito.UserPool;
  public readonly userPoolClient: cognito.UserPoolClient;

  constructor(scope: Construct, id: string, props: Props) {
    super(scope, id, props);
    const { cfg } = props;

    this.userPool = new cognito.UserPool(this, 'UserPool', {
      userPoolName: `tums-${cfg.env}`,
      selfSignUpEnabled: false, // operators are invited, not self-registered
      signInAliases: { email: true },
      mfa: cognito.Mfa.OPTIONAL, // owner decision 2026-10-28: not enforced; TOTP offered alongside SMS
      mfaSecondFactor: { sms: true, otp: true },
      passwordPolicy: { minLength: 12, requireSymbols: true, requireDigits: true, requireUppercase: true },
      customAttributes: { tenantId: new cognito.StringAttribute({ mutable: false }) },
      // Threat protection (compromised-credential + adaptive risk checks) on the only auth boundary (feature-47).
      featurePlan: cognito.FeaturePlan.PLUS,
      standardThreatProtectionMode: cognito.StandardThreatProtectionMode.FULL_FUNCTION,
      deletionProtection: true, // RETAIN stops CloudFormation, not a DeleteUserPool call
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    this.userPoolClient = this.userPool.addClient('WebClient', {
      // userSrp powers the real browser login; adminUserPassword allows server-side/CI auth
      // for automated end-to-end testing of the API.
      authFlows: { userSrp: true, adminUserPassword: true },
      // No hosted-UI / OAuth flow is used by the SPA (it was configured with an example.com callback).
      // Short-lived tokens: the SPA keeps them in sessionStorage; a stolen refresh token is good for a day,
      // not the 30-day default (feature-47, audit #7).
      idTokenValidity: cdk.Duration.hours(1),
      accessTokenValidity: cdk.Duration.hours(1),
      refreshTokenValidity: cdk.Duration.days(1),
      preventUserExistenceErrors: true, // no username enumeration through error messages
      disableOAuth: true,
    });

    // Members of this group may manage DORA target repos (POST/DELETE /v1/dora/repos…). The API
    // checks the `cognito:groups` claim server-side; the UI merely hides the admin controls.
    // Add a user: aws cognito-idp admin-add-user-to-group --user-pool-id <id> --username <email> --group-name admin
    new cognito.CfnUserPoolGroup(this, 'AdminGroup', {
      userPoolId: this.userPool.userPoolId,
      groupName: 'admin',
      description: 'Dashboard administrators (manage DORA target repos)',
    });

    new cdk.CfnOutput(this, 'UserPoolId', { value: this.userPool.userPoolId });
    new cdk.CfnOutput(this, 'UserPoolClientId', { value: this.userPoolClient.userPoolClientId });
  }
}
