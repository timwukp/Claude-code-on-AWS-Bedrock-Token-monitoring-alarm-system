# Intent: the CloudWatch Logs subscriptions create on the first try

- **Slug:** lakehouse-p1-subscription-race
- **Author:** Claude (AI agent)
- **Date:** 2026-10-28
- **Accepted-by:** Tim WU
- **Status:** shipped

## Problem
Sixth dev deploy reached 46/52 (both Firehose → Iceberg streams created) and failed on the two
`AWS::Logs::SubscriptionFilter`s: CloudWatch Logs test-delivers while creating a filter, and the Logs→Firehose role's
permission lived in a separate `AWS::IAM::Policy` that was not attached yet.

## Desired outcome
The Logs→Firehose and Metric Stream roles carry `firehose:PutRecord/PutRecordBatch` inline and the filters depend on
the role explicitly, pinned by a test.
