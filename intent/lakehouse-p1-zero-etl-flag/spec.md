# Spec: zero-ETL behind a flag

- **Intent:** ./intent.md
- **Author:** Claude (AI agent)
- **Accepted-by:** Tim WU
- **Status:** signed-off

`EnvConfig.lakehouse.enableZeroEtl?: boolean`; `LakehouseStack` creates the two integrations, their resource properties
and the source/target roles only when it is `true`. Test: 0 integrations by default, 2 with the flag.
