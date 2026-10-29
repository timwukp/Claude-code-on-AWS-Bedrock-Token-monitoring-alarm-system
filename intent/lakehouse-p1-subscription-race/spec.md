# Spec: inline PutRecord permissions

- **Intent:** ./intent.md
- **Author:** Claude (AI agent)
- **Accepted-by:** Tim WU
- **Status:** shipped

`LogsToFirehoseRole` and `MetricStreamRole` use `inlinePolicies` for the Firehose PutRecord statement; both
`CfnSubscriptionFilter`s `addDependency(cwlRole)`. Test: two roles with inline PutRecord; both filters depend on the role.
