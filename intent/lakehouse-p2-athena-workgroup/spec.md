# Spec: dedicated lakehouse workgroup

- **Intent:** ./intent.md
- **Author:** Claude (AI agent)
- **Accepted-by:** Tim WU
- **Status:** shipped

`LakehouseSilver` creates `AWS::Athena::WorkGroup tums-lakehouse-<env>` (enforced, SSE_S3, output `s3://<results>/lakehouse/`);
jobs roles get Athena actions on it; the SFN tasks and the Lambdas' `ATHENA_WORKGROUP`/`ATHENA_OUTPUT` use it; scripts
default to it. Test: workgroup present with SSE_S3; state machine and every Lambda env reference it, not the KMS one.
