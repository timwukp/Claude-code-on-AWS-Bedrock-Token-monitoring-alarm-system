# Intent: the Firehose → Iceberg streams create

- **Slug:** lakehouse-p1-firehose-fixes
- **Author:** Claude (AI agent)
- **Date:** 2026-10-28
- **Accepted-by:** Tim WU
- **Status:** shipped

## Problem
Fifth dev deploy reached 44/52 (Lake Formation, CUR, tables, Lambdas, Metric Stream all created) and both Firehose
streams failed: the bedrock stream because Iceberg destinations accept only the Lambda processor ("DecompressionProcessor
is currently only supported for destination type S3, Splunk and Snowflake"), the metrics stream because the Firehose role
could not `glue:GetTable` the destination through the S3 Tables federated catalog (the role's Glue resources did not
include the `catalog/s3tablescatalog` level nor `glue:GetCatalog`).

## Desired outcome
Lambda-only processing (the transform already unpacks CloudWatch Logs envelopes and re-ingests overflow rows) and a
Glue resource list that covers every level of the federated catalog, both pinned by tests.
