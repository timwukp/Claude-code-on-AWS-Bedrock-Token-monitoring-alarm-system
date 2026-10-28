# Spec: P1 deploy fixes

- **Intent:** ./intent.md
- **Author:** Claude (AI agent)
- **Accepted-by:** Tim WU
- **Status:** shipped

1. CUR bucket: SSE-S3; one bucket-policy statement for `billingreports.amazonaws.com` + `bcm-data-exports.amazonaws.com`
   with `aws:SourceArn` ∈ {`arn:aws:cur:us-east-1:<acct>:definition/*`, `arn:aws:bcm-data-exports:us-east-1:<acct>:export/*`}
   and `aws:SourceAccount`; `CurExport` depends on the bucket policy.
2. `docs/LAKEHOUSE.md` runbook: Lake Formation admin bootstrap for the CDK exec role; S3 Tables name cooldown; RETAIN orphans.
