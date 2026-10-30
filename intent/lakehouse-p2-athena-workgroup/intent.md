# Intent: silver jobs can write to S3 Tables

- **Slug:** lakehouse-p2-athena-workgroup
- **Author:** Claude (AI agent)
- **Date:** 2026-10-30
- **Accepted-by:** Tim WU
- **Status:** accepted

## Problem
After the P2 deploy every silver job failed with `INTERNAL_ERROR_QUERY_ENGINE`: Athena `INSERT`/`MERGE` into S3 Tables
fails when the workgroup's result encryption is SSE_KMS (controlled experiment: the same statement succeeded under SSE_S3
and in `primary`; `UPDATE`/`DELETE` touching no rows succeeded either way). The dashboard's `token-monitoring-<env>`
workgroup is SSE_KMS by design.

## Desired outcome
Lakehouse jobs (state machine, dim_model refresh, registry snapshot, quality gate, verify/smoke scripts) run in a
dedicated `tums-lakehouse-<env>` workgroup with SSE_S3 results; the dashboard workgroup is unchanged.
