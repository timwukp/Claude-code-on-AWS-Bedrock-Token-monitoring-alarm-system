-- quality_60: token counts are never negative. Empty result = PASS. Parameters: ${CATALOG}.
SELECT t_invocations.request_id, t_invocations.input_tokens, t_invocations.output_tokens, t_invocations.cache_read_tokens, t_invocations.cache_write_tokens
FROM ${CATALOG}.silver.invocations t_invocations
WHERE t_invocations.event_day >= cast(date_add('day', -2, current_date) as varchar)
  AND (t_invocations.input_tokens < 0 OR t_invocations.output_tokens < 0
       OR coalesce(t_invocations.cache_read_tokens, 0) < 0 OR coalesce(t_invocations.cache_write_tokens, 0) < 0)
LIMIT 20
