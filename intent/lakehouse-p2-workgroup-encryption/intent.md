# Intent: silver jobs write to the KMS-encrypted S3 Tables bucket

- **Slug:** lakehouse-p2-workgroup-encryption
- **Author:** Claude (AI agent)
- **Date:** 2026-10-30
- **Accepted-by:** Tim WU
- **Status:** accepted

## Problem
#114 moved the silver jobs to a dedicated SSE_S3 workgroup; they still failed with `INTERNAL_ERROR_QUERY_ENGINE`. Four
controlled experiments isolated the trigger: Athena `INSERT`/`MERGE` into a **KMS-encrypted** S3 Tables bucket fails whenever
the workgroup carries an explicit result `EncryptionConfiguration` (SSE_S3 or SSE_KMS); with none set the same statements
succeed (`primary`, and an enforced probe workgroup without the setting), and result objects inherit the results bucket's
default KMS encryption.

## Desired outcome
`tums-lakehouse-<env>` keeps enforced configuration and the 50 GiB cutoff but sets no result encryption; the runbook records
the four experiments so nobody re-adds the setting.
