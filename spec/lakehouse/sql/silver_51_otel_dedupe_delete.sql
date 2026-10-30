-- silver_51: remove the OTel rows whose fields were folded into a Bedrock row by silver_50. Parameters: ${CATALOG}.
DELETE FROM ${CATALOG}.silver.invocations
WHERE source = 'otel'
  AND event_day >= cast(date_add('day', -2, current_date) as varchar)
  AND request_id IN (SELECT t_invocations.request_id FROM ${CATALOG}.silver.invocations t_invocations
                     WHERE t_invocations.source = 'both'
                       AND t_invocations.event_day >= cast(date_add('day', -3, current_date) as varchar))
