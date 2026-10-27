# Intent: the first Lakehouse deploy succeeds on a clean account

- **Slug:** lakehouse-p1-deploy-fixes
- **Author:** Claude (AI agent)
- **Date:** 2026-10-27
- **Accepted-by:** Tim WU
- **Status:** accepted

## Problem
Deploying `Tums-dev-Lakehouse` (#79) failed three times, each on a different wall: (1) the CUR bucket policy let only
one of the two Data Exports principals validate (`AWS::BCMDataExports::Export` → "S3 bucket permission validation
failed"); (2) a deleted S3 Tables bucket name is unusable for ~10–15 minutes and a failed first create leaves RETAIN
resources behind; (3) Lake Formation grants fail unless the CDK execution role is a data-lake administrator.

## Desired outcome
Policy, encryption and dependency fixed in code with a pinning test; the bootstrap and retry runbook written down so
the next account does not rediscover them.
