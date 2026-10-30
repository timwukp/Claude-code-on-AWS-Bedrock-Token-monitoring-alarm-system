-- silver_20 (hourly, last 2 days): recompute project_id / attribution_source for recent silver rows from the CURRENT registry snapshot.
-- Rule C (owner, 2026-10-24): (1) application inference profile, (2) registered identity (tenant_key is already the
-- role/user ARN — sessions collapsed), (3) the Lambda's requestMetadata attribution, else untagged/none.
-- Idempotent: only rows whose computed pair differs are updated. Parameters: ${CATALOG} (quoted catalog).
MERGE INTO ${CATALOG}.silver.invocations t_invocations
USING (
  WITH cur AS (
    SELECT t_project_registry.project_id, t_project_registry.profile_arns, t_project_registry.identity_arns
    FROM ${CATALOG}.silver.project_registry t_project_registry
    WHERE t_project_registry.is_current = true
  ),
  inv AS (
    SELECT t_invocations.request_id,
           min(t_invocations.aip_arn)            AS aip_arn,
           min(t_invocations.tenant_key)         AS tenant_key,
           min(t_invocations.project_id)         AS project_id,
           min(t_invocations.attribution_source) AS attribution_source
    FROM ${CATALOG}.silver.invocations t_invocations
    WHERE t_invocations.event_day >= cast(date_add('day', -2, current_date) as varchar)
    GROUP BY t_invocations.request_id
  ),
  by_aip AS (
    SELECT i.request_id, min(r.project_id) AS project_id
    FROM inv i JOIN cur r
      ON i.aip_arn IS NOT NULL AND r.profile_arns IS NOT NULL
     AND json_array_contains(json_parse(r.profile_arns), i.aip_arn)
    GROUP BY i.request_id
  ),
  by_identity AS (
    SELECT i.request_id, min(r.project_id) AS project_id
    FROM inv i JOIN cur r
      ON i.tenant_key IS NOT NULL AND r.identity_arns IS NOT NULL
     AND json_array_contains(json_parse(r.identity_arns), i.tenant_key)
    GROUP BY i.request_id
  )
  SELECT i.request_id,
         coalesce(a.project_id, d.project_id,
                  CASE WHEN i.attribution_source = 'metadata' THEN i.project_id END,
                  'untagged') AS project_id,
         CASE WHEN a.project_id IS NOT NULL THEN 'aip'
              WHEN d.project_id IS NOT NULL THEN 'identity'
              WHEN i.attribution_source = 'metadata' THEN 'metadata'
              ELSE 'none' END AS attribution_source
  FROM inv i
  LEFT JOIN by_aip a      ON a.request_id = i.request_id
  LEFT JOIN by_identity d ON d.request_id = i.request_id
) s
ON t_invocations.request_id = s.request_id
   AND t_invocations.event_day >= cast(date_add('day', -2, current_date) as varchar)
WHEN MATCHED AND (t_invocations.project_id <> s.project_id OR t_invocations.attribution_source <> s.attribution_source)
  THEN UPDATE SET project_id = s.project_id, attribution_source = s.attribution_source
