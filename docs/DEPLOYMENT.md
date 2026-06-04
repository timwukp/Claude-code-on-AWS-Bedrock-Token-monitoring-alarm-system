# Deployment Guide

Step-by-step deploy of the Token Usage Monitoring System into **your** AWS account. No
customer-specific values are hard-coded — everything lives in `infra/lib/config/<env>.json`.

## 0. Prerequisites

- AWS account + credentials with deploy permissions (`aws configure` or SSO).
- Node.js 20+, npm, Docker (for Lambda bundling + the Fargate ETL image).
- AWS CDK v2: `npm i -g aws-cdk`.
- Amazon Bedrock model access enabled in your target Region.

## 1. Configure your environment

```bash
cp infra/lib/config/example.env.json infra/lib/config/dev.json
$EDITOR infra/lib/config/dev.json   # set account, region, bucket names, budget, emails
```

## 2. Install dependencies

```bash
( cd infra && npm install )
( cd backend && npm install )
( cd frontend && npm install )
```

## 3. Bootstrap CDK (first time per account/region)

```bash
cd infra && cdk bootstrap aws://<account>/<region>
```

## 4. Deploy the backend & infrastructure

```bash
cd infra
cdk deploy --all --context env=dev
```

Note the stack outputs (API URL, Cognito IDs, CloudFront domain, SNS topic ARN).

## 5. Enable Bedrock Model Invocation Logging

If the L1 logging resource isn't available in your CDK version, run the verified CLI step:

```bash
aws bedrock put-model-invocation-logging-configuration \
  --logging-config '{ "s3Config": { "bucketName": "<your-raw-log-bucket>", "keyPrefix": "model-logs/" } }' \
  --region <region>
```

## 6. Set up Cost Anomaly Detection

```bash
./scripts/setup-cost-anomaly.sh <SNS_TOPIC_ARN_from_outputs> 10
```

## 7. Create the Athena table

Run the `CREATE EXTERNAL TABLE` DDL from `docs/MONITORING_APPROACH.md` (§2) in the Athena
console against the `token_monitoring_<env>` database, pointing `LOCATION` at your raw log
bucket prefix. Confirm the date sub-path in the S3 console and add partition projection.

## 8. Publish the frontend

```bash
cp frontend/.env.example frontend/.env.local   # fill from stack outputs
./scripts/deploy-frontend.sh dev
```

Open the `DistributionDomainName` from the Frontend stack outputs.

## 9. Create an operator user

```bash
aws cognito-idp admin-create-user --user-pool-id <pool-id> --username you@example.com \
  --user-attributes Name=email,Value=you@example.com Name=custom:tenantId,Value=demo
```

## Teardown

```bash
cd infra && cdk destroy --all --context env=dev
```

> Data buckets and DynamoDB tables use `RETAIN` to protect audit data — delete them manually
> after confirming you no longer need the logs.
