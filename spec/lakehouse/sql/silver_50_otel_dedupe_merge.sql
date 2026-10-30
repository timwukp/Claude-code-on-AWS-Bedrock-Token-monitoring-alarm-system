-- silver_50: when the same request_id has a Bedrock row and an OTel row, fold the OTel-only fields into the Bedrock
-- row (tokens stay the Bedrock envelope's) and mark it source='both'. silver_51 then deletes the OTel row.
-- Parameters: ${CATALOG}. Window: last 2 days.
MERGE INTO ${CATALOG}.silver.invocations t_invocations
USING (
  SELECT o.request_id,
         min(o.session_id)      AS session_id,
         min(o.conversation_id) AS conversation_id,
         min(o.trace_id)        AS trace_id,
         min(o.span_id)         AS span_id,
         min(o.service_name)    AS service_name,
         min(o.latency_ms)      AS latency_ms,
         min(o.ttft_ms)         AS ttft_ms
  FROM ${CATALOG}.silver.invocations o
  WHERE o.source = 'otel'
    AND o.event_day >= cast(date_add('day', -2, current_date) as varchar)
    AND EXISTS (SELECT 1 FROM ${CATALOG}.silver.invocations b
                WHERE b.request_id = o.request_id AND b.source = 'bedrock'
                  AND b.event_day >= cast(date_add('day', -3, current_date) as varchar))
  GROUP BY o.request_id
) s
ON  t_invocations.request_id = s.request_id
AND t_invocations.source = 'bedrock'
AND t_invocations.event_day >= cast(date_add('day', -3, current_date) as varchar)
WHEN MATCHED THEN UPDATE SET
  source          = 'both',
  session_id      = coalesce(t_invocations.session_id, s.session_id),
  conversation_id = coalesce(t_invocations.conversation_id, s.conversation_id),
  trace_id        = coalesce(t_invocations.trace_id, s.trace_id),
  span_id         = coalesce(t_invocations.span_id, s.span_id),
  service_name    = coalesce(t_invocations.service_name, s.service_name),
  latency_ms      = coalesce(t_invocations.latency_ms, s.latency_ms),
  ttft_ms         = coalesce(t_invocations.ttft_ms, s.ttft_ms)
