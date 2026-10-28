# Intent: ship the bronze core without the zero-ETL mirrors

- **Slug:** lakehouse-p1-zero-etl-flag
- **Author:** Claude (AI agent)
- **Date:** 2026-10-28
- **Accepted-by:** Tim WU
- **Status:** accepted

## Problem
The fourth Lakehouse deploy reached 34/61 resources and failed on the Glue zero-ETL `IntegrationResourceProperty` for the
DynamoDB sources ("The glue connection ARN arn:aws:dynamodb:… is invalid"). Each failed first create costs a ~15-minute
S3 Tables bucket-name cooldown and an orphan cleanup, and the DORA/registry mirrors are not needed by anything until P2.

## Desired outcome
Zero-ETL constructs exist only behind `lakehouse.enableZeroEtl` (default off); the bronze core (tables, Firehose,
Metric Streams, CUR, Lake Formation, alarms) deploys without them. The resource-shape fix lands when proven.
