# ADR 0001 — CDK + hybrid serverless/Fargate

- **Status:** Accepted
- **Date:** 2026-06-03

## Context

We need IaC and a compute model for a Bedrock token-monitoring platform that is event-driven
(CloudTrail → response), API-driven (dashboard), and analytics-heavy (log compaction, reports),
deployable into any customer's AWS account and publishable as open source.

## Decision

- **IaC: AWS CDK (TypeScript).** Type-safe, shares the language with the frontend, has rich L2
  constructs and first-class Well-Architected examples. Trade-off: AWS-specific (acceptable —
  this is an AWS-native product).
- **Compute: hybrid.** Lambda for the API and event paths (scale-to-zero, cheapest for spiky
  work); ECS Fargate for the single long-running ETL job that exceeds Lambda's limits.

## Consequences

- Two runtimes to operate, bounded by keeping Fargate to one well-scoped task.
- Dashboard reads hit DynamoDB pre-aggregates, not Athena, keeping the UI fast and scans cheap.
- Stacks are split for small blast radius and independent deploys.

## Alternatives considered

- **Terraform:** more multi-cloud/community reach, but loses CDK's typed construct ergonomics.
- **All-serverless:** simplest to operate, but Lambda's 15-min/memory limits are awkward for
  large Parquet compaction at volume.
- **All-Fargate/ECS:** removes a runtime, but pays for idle capacity on bursty API/event paths.
