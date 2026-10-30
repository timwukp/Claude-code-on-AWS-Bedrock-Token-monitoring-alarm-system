-- quality_61: every row has a model_key and a vendor. Empty result = PASS. Parameters: ${CATALOG}.
SELECT t_invocations.request_id, t_invocations.model_id_raw, t_invocations.model_key, t_invocations.vendor
FROM ${CATALOG}.silver.invocations t_invocations
WHERE t_invocations.event_day >= cast(date_add('day', -2, current_date) as varchar)
  AND (t_invocations.model_key IS NULL OR t_invocations.model_key = '' OR t_invocations.vendor IS NULL OR t_invocations.vendor = '')
LIMIT 20
