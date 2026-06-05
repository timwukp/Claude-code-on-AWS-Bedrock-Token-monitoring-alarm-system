/**
 * Environment configuration contract for the Token Usage Monitoring System.
 *
 * Everything customer-/environment-specific lives in a JSON file under this directory
 * (e.g. dev.json) so the same CDK code deploys to any AWS account with no code changes.
 */
export interface EnvConfig {
  /** Logical environment name, e.g. "dev" | "staging" | "prod". */
  readonly env: string;
  /** Target AWS account ID. */
  readonly account: string;
  /** Target AWS Region, e.g. "ap-southeast-1". */
  readonly region: string;

  /** Raw Bedrock invocation logs land here; key prefix is appended by Bedrock. */
  readonly logBucketName: string;
  /** Curated Parquet layer produced by the Fargate ETL. */
  readonly curatedBucketName: string;
  /** Days to retain raw logs before lifecycle expiry (audit policy dependent). */
  readonly rawLogRetentionDays: number;

  /** Cognito + frontend. */
  readonly frontend: {
    /** Optional custom domain; if omitted, the CloudFront domain is used. */
    readonly domainName?: string;
    /** ACM certificate ARN (us-east-1) for the custom domain, if any. */
    readonly certificateArn?: string;
  };

  /** API options. */
  readonly api?: {
    /**
     * Allowed CORS origins for the API. In production set this to your dashboard origin(s)
     * (the CloudFront domain or custom domain). If omitted/empty, CORS falls back to "*"
     * (convenient for demo, NOT recommended for production).
     */
    readonly allowedOrigins?: string[];
  };

  /** Cost governance. */
  readonly governance: {
    /** Monthly Bedrock budget in USD. */
    readonly monthlyBudgetUsd: number;
    /** Absolute $ anomaly impact threshold for an immediate alert. */
    readonly anomalyImpactUsd: number;
    /** Email recipients for budget/anomaly summaries. */
    readonly alertEmails: string[];
  };

  /**
   * Auto-containment switch. Defaults to false (notify-only) per the Well-Architected
   * Security pillar — opt in deliberately and per tenant.
   */
  readonly enableAutoContainment: boolean;

  /**
   * Optional hard-stop enforcement config. When `budgetActionThresholdPct` is set (and
   * `enableAutoContainment` is true), a Budget Action applies a restrictive IAM policy at that
   * percent of the monthly budget. `budgetActionRoleArns` lists the role(s) the deny policy is
   * attached to — point these at scoped/test roles, NOT your admin identity, to avoid lockout.
   */
  readonly enforcement?: {
    readonly budgetActionThresholdPct?: number;
    readonly budgetActionRoleArns?: string[];
  };
}
