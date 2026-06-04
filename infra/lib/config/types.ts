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
}
