-- silver_40: fold bronze.cw_metrics (Metric Streams datapoints) to the hour per namespace / metric / model / project.
-- AWS/Bedrock uses the ModelId dimension; AWS/BedrockMantle uses Model (+ Project). Parameters: ${CATALOG}. Window: last 2 days.
MERGE INTO ${CATALOG}.silver.bedrock_metrics_hourly t_bedrock_metrics_hourly
USING (
  SELECT date_trunc('hour', t_cw_metrics.metric_ts)                    AS hour_ts,
         cast(date(date_trunc('hour', t_cw_metrics.metric_ts)) as varchar) AS hour_day,
         t_cw_metrics.namespace,
         t_cw_metrics.metric_name,
         coalesce(json_extract_scalar(t_cw_metrics.dimensions, '$.ModelId'),
                  json_extract_scalar(t_cw_metrics.dimensions, '$.Model')) AS model_id,
         json_extract_scalar(t_cw_metrics.dimensions, '$.Project')          AS project,
         sum(t_cw_metrics.sum)   AS sum,
         sum(t_cw_metrics.count) AS count,
         min(t_cw_metrics.min)   AS min,
         max(t_cw_metrics.max)   AS max
  FROM ${CATALOG}.bronze.cw_metrics t_cw_metrics
  WHERE t_cw_metrics.metric_day >= cast(date_add('day', -2, current_date) as varchar)
  GROUP BY 1, 2, 3, 4, 5, 6
) s
ON  t_bedrock_metrics_hourly.hour_ts = s.hour_ts
AND t_bedrock_metrics_hourly.namespace = s.namespace
AND t_bedrock_metrics_hourly.metric_name = s.metric_name
AND coalesce(t_bedrock_metrics_hourly.model_id, '') = coalesce(s.model_id, '')
AND coalesce(t_bedrock_metrics_hourly.project, '') = coalesce(s.project, '')
WHEN MATCHED AND (t_bedrock_metrics_hourly.sum <> s.sum OR t_bedrock_metrics_hourly.count <> s.count)
  THEN UPDATE SET sum = s.sum, count = s.count, min = s.min, max = s.max
WHEN NOT MATCHED
  THEN INSERT (hour_ts, hour_day, namespace, metric_name, model_id, project, sum, count, min, max)
       VALUES (s.hour_ts, s.hour_day, s.namespace, s.metric_name, s.model_id, s.project, s.sum, s.count, s.min, s.max)
