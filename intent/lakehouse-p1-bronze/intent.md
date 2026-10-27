# Intent: every source record lands, verbatim and governed, before anything derives from it

- **Slug:** lakehouse-p1-bronze
- **Author:** Claude (AI agent)
- **Date:** 2026-10-27
- **Accepted-by:** Tim WU
- **Status:** shipped

## Problem

Chain 2 of the lakehouse programme (plan `floating-enchanting-kahan`, approved 2026-10-24). P0 (#76/#77) stopped the
bleeding: the Full view reads curated Parquet and the ETL runs. But the platform still has no governed landing zone:

1. **Bedrock records reach analytics only through Bedrock's own S3 delivery prefix**, where request/response bodies
   (`data/`, 96 % of the bytes, PII) sit beside the records, and only through a daily batch ETL. There is no
   schema-on-write layer that any body shape can fail against harmlessly (plan **R1**), and no near-real-time path.
2. **Three sources have no durable copy at all.** CloudWatch metrics (`AWS/Bedrock`, `AWS/BedrockMantle`) are read
   live and vanish from `ListMetrics` after two weeks (qa F-PR77-002); the bill is polled from Cost Explorer with
   four days of lookback; OpenTelemetry spans from gateways/agents (already in X-Ray Transaction Search) are not
   captured anywhere (plan **R4**, **R12**).
3. **Nothing alarms when a pipeline step fails** beyond the P0 ETL alarm (plan **R9**).
4. **Attribution still lacks the config-side tooling**: a repo cannot be pointed at its project's application
   inference profile without hand-work (owner decision 2026-10-27: AIP per repo); and a fresh worktree published a
   frontend with no Cognito config on 2026-10-26.

## Desired outcome

- A **bronze** layer in Amazon S3 Tables (`tums-lakehouse-<env>`): `bronze.bedrock_invocations`, `bronze.cw_metrics`,
  `bronze.otel_spans`, plus the Glue external table `cur_raw` over a CUR 2.0 Data Export — each declared once in
  `spec/lakehouse/*.schema.json`, each keeping the producer's record verbatim in `raw`, retained forever, readable only
  by the pipeline roles and the owner (Lake Formation), registered (not published) in the SMUS project.
- Bedrock logging additionally delivers to **CloudWatch Logs** with large bodies to a separate bucket; a subscription
  filter → Firehose → transform Lambda → Iceberg path lands records in minutes; the S3 destination stays for the
  aggregator/ETL.
- Metric Streams and Transaction Search spans flow through the same Firehose pattern; failures land in an errors
  bucket and alarm; Firehose freshness alarms.
- `scripts/create-project-aip.sh` creates tagged profiles per project and prints the repo's `.claude/settings.json`;
  `scripts/deploy-frontend.sh` refuses to publish a bundle whose Cognito pool is missing or wrong;
  `scripts/lakehouse-smoke.ts` proves seven vendor body shapes and a metric datapoint land with zero errors.
- Tests first: infra assertions for every resource, pure-function tests for the transform, a spec↔generated-artefact
  consistency test.

## Out of scope (later chains)

Silver normalisation and attribution recompute (P2); gold aggregates, read-side switch, QuickSight (P3); retiring the
Fargate ETL / Cost Explorer poller / S3 log destination (after P3); Glue zero-ETL from DynamoDB if the L1 resources
do not synthesise in this chain (then P2, documented as TODO in `docs/LAKEHOUSE.md`).
