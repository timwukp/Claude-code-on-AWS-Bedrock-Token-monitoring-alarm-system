-- silver_30: fold CUR 2.0 lines (bronze.cur_raw, Glue external table) into day × usage type × line-item type × region.
-- Usage-type parsing ports backend/lambdas/ingestion/bill-parse.ts (the authority):
--   current scheme  <model>-mantle-<kind>[-1h|-30m][-global-standard|-standard]   ("-mantle-" is on EVERY model's line)
--   legacy scheme   Claude4.6Sonnet-<kind words>[-cross-region-global]           (no suffix = standard)
-- plus two folds bill-parse leaves as 'other': Guardrail* → guardrail, *provisioned* → provisioned_hour, and the generic
-- third-party names <Name>-(input|output)-tokens (DeepSeek-R1, NovaMicro, Llama3-8B…) → input/output with the lower-cased
-- name as model_key. Anything else stays kind 'other' — a billed line is never dropped.
-- Parameters: ${CATALOG} (quoted), ${GLUE_DB}. Window: last 35 days (CUR restates recent days).
MERGE INTO ${CATALOG}.silver.bill_daily t_bill_daily
USING (
  WITH lines AS (
    SELECT cast(date(t_cur_raw.line_item_usage_start_date) as varchar) AS day,
           t_cur_raw.line_item_usage_type                              AS usage_type,
           t_cur_raw.line_item_line_item_type                          AS line_item_type,
           t_cur_raw.product_region_code                               AS region,
           sum(t_cur_raw.line_item_unblended_cost)                     AS usd,
           sum(t_cur_raw.line_item_usage_amount)                       AS qty
    FROM ${GLUE_DB}.cur_raw t_cur_raw
    WHERE t_cur_raw.line_item_usage_start_date >= date_add('day', -35, current_timestamp)
      AND t_cur_raw.product_servicecode IN ('AmazonBedrock', 'AmazonBedrockService', 'AmazonBedrockFoundationModels')
    GROUP BY 1, 2, 3, 4
  ),
  parsed AS (
    SELECT l.*,
           regexp_replace(l.usage_type, '^[A-Z]{2,4}[0-9]-', '') AS rest
    FROM lines l
  ),
  kinds AS (
    SELECT p.day, p.usage_type, p.line_item_type, p.region, p.usd, p.qty, p.rest,
           regexp_extract(p.rest, '^(.*?)-mantle-(input-tokens|output-tokens|cache-read-tokens|cache-write-tokens(?:-1h|-30m)?)(?:-(global-standard|standard))?$', 1) AS cur_model,
           regexp_extract(p.rest, '^(.*?)-mantle-(input-tokens|output-tokens|cache-read-tokens|cache-write-tokens(?:-1h|-30m)?)(?:-(global-standard|standard))?$', 2) AS cur_kind,
           regexp_extract(p.rest, '^(.*?)-mantle-(input-tokens|output-tokens|cache-read-tokens|cache-write-tokens(?:-1h|-30m)?)(?:-(global-standard|standard))?$', 3) AS cur_route,
           regexp_extract(p.rest, '^(Claude[0-9.]+(?:Sonnet|Haiku|Opus))-(input-tokens|output-tokens|cache-read-input-token-count|cache-write-input-token-count)(-cross-region-global)?$', 1) AS leg_name,
           regexp_extract(p.rest, '^(Claude[0-9.]+(?:Sonnet|Haiku|Opus))-(input-tokens|output-tokens|cache-read-input-token-count|cache-write-input-token-count)(-cross-region-global)?$', 2) AS leg_kind,
           regexp_extract(p.rest, '^(Claude[0-9.]+(?:Sonnet|Haiku|Opus))-(input-tokens|output-tokens|cache-read-input-token-count|cache-write-input-token-count)(-cross-region-global)?$', 3) AS leg_global,
           regexp_extract(p.rest, '^(.+?)-(input|output)-tokens$', 1) AS gen_model,
           regexp_extract(p.rest, '^(.+?)-(input|output)-tokens$', 2) AS gen_kind
    FROM parsed p
  )
  SELECT k.day, k.usage_type, k.line_item_type, k.region, k.usd, k.qty,
         CASE
           WHEN k.cur_kind IS NOT NULL THEN k.cur_model
           WHEN k.leg_name IS NOT NULL THEN 'anthropic.claude-' || lower(regexp_extract(k.leg_name, '^Claude[0-9.]+(Sonnet|Haiku|Opus)$', 1))
                                            || '-' || replace(regexp_extract(k.leg_name, '^Claude([0-9.]+)', 1), '.', '-')
           WHEN k.rest LIKE 'Guardrail%' THEN NULL
           WHEN k.gen_kind IS NOT NULL THEN lower(k.gen_model)
           ELSE NULL
         END AS model_key,
         CASE
           WHEN k.cur_kind = 'input-tokens' OR k.leg_kind = 'input-tokens' THEN 'input'
           WHEN k.cur_kind = 'output-tokens' OR k.leg_kind = 'output-tokens' THEN 'output'
           WHEN k.cur_kind = 'cache-read-tokens' OR k.leg_kind = 'cache-read-input-token-count' THEN 'cache_read'
           WHEN k.cur_kind = 'cache-write-tokens-1h' THEN 'cache_write_1h'
           WHEN k.cur_kind = 'cache-write-tokens-30m' THEN 'cache_write_30m'
           WHEN k.cur_kind = 'cache-write-tokens' OR k.leg_kind = 'cache-write-input-token-count' THEN 'cache_write_5m'
           WHEN k.rest LIKE 'Guardrail%' THEN 'guardrail'
           WHEN lower(k.rest) LIKE '%provisioned%' THEN 'provisioned_hour'
           WHEN k.gen_kind = 'input' THEN 'input'
           WHEN k.gen_kind = 'output' THEN 'output'
           ELSE 'other'
         END AS kind,
         CASE
           WHEN k.cur_route = 'global-standard' OR k.leg_global IS NOT NULL THEN 'global'
           WHEN k.cur_route = 'standard' OR (k.leg_kind IS NOT NULL AND k.leg_global IS NULL) THEN 'standard'
           WHEN k.gen_kind IS NOT NULL THEN 'standard'
           ELSE 'other'
         END AS route
  FROM kinds k
) s
ON  t_bill_daily.day = s.day
AND t_bill_daily.usage_type = s.usage_type
AND coalesce(t_bill_daily.line_item_type, '') = coalesce(s.line_item_type, '')
AND coalesce(t_bill_daily.region, '') = coalesce(s.region, '')
WHEN MATCHED AND (t_bill_daily.usd <> s.usd OR t_bill_daily.qty <> s.qty)
  THEN UPDATE SET usd = s.usd, qty = s.qty, model_key = s.model_key, kind = s.kind, route = s.route, refreshed_at = current_timestamp
WHEN NOT MATCHED
  THEN INSERT (day, usage_type, model_key, kind, route, region, line_item_type, usd, qty, source, refreshed_at)
       VALUES (s.day, s.usage_type, s.model_key, s.kind, s.route, s.region, s.line_item_type, s.usd, s.qty, 'cur', current_timestamp)
