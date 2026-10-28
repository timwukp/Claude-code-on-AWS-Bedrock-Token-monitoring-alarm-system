# Spec: Firehose fixes

- **Intent:** ./intent.md
- **Author:** Claude (AI agent)
- **Accepted-by:** Tim WU
- **Status:** signed-off

1. Both streams: `processingConfiguration.processors = [Lambda]`.
2. Firehose role: `glue:GetTable/GetTables/GetDatabase/GetDatabases/UpdateTable/GetCatalog/GetCatalogs` on `catalog`,
   `catalog/s3tablescatalog`, `catalog/s3tablescatalog/<bucket>`, `catalog/s3tablescatalog/<bucket>/*`,
   `database/s3tablescatalog/<bucket>/*`, `table/s3tablescatalog/<bucket>/*/*`.
