-- quality_62: attribution_source is one of the five allowed values and project_id is never empty. Empty = PASS. Parameters: ${CATALOG}.
SELECT t_invocations.request_id, t_invocations.project_id, t_invocations.attribution_source
FROM ${CATALOG}.silver.invocations t_invocations
WHERE t_invocations.event_day >= cast(date_add('day', -2, current_date) as varchar)
  AND (t_invocations.attribution_source NOT IN ('aip', 'identity', 'metadata', 'workspace', 'none')
       OR t_invocations.project_id IS NULL OR t_invocations.project_id = '')
LIMIT 20
