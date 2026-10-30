-- quality_64: after silver_50/51 no request_id has more than one row in the window. Empty = PASS. Parameters: ${CATALOG}.
SELECT t_invocations.request_id, count(*) AS rows, array_agg(t_invocations.source) AS sources
FROM ${CATALOG}.silver.invocations t_invocations
WHERE t_invocations.event_day >= cast(date_add('day', -2, current_date) as varchar)
GROUP BY t_invocations.request_id
HAVING count(*) > 1
LIMIT 20
