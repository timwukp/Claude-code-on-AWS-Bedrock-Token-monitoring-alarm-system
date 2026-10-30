# Spec: workgroup without explicit result encryption

- **Intent:** ./intent.md
- **Author:** Claude (AI agent)
- **Accepted-by:** Tim WU
- **Status:** signed-off

`LakehouseSilver` workgroup: `resultConfiguration = { outputLocation }` only; test asserts `EncryptionConfiguration` is
undefined and the cutoff/enforcement remain. `docs/LAKEHOUSE.md` runbook item rewritten with the experiment matrix.
