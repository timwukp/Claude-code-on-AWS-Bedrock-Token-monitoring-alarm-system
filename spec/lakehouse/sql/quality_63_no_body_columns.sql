-- quality_63: silver.invocations carries no prompt/response body column (only the body_s3_path pointer). Empty = PASS.
-- Parameters: ${CATALOG}. Reads information_schema of the S3 Tables catalog.
SELECT column_name
FROM ${CATALOG}.information_schema.columns
WHERE table_schema = 'silver' AND table_name = 'invocations'
  AND lower(column_name) LIKE '%body%' AND column_name <> 'body_s3_path'
LIMIT 20
