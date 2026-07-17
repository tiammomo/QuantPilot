-- Turn the calibrated built-in member limits into actual cost controls. User
-- overrides still take precedence, while administrators remain exempt because
-- bootstrap/ensure-access-control leaves their quota_profile_id NULL.
UPDATE "quota_rules"
SET
  "enforcement" = 'hard',
  "updated_at" = CURRENT_TIMESTAMP
WHERE "profile_id" = (
  SELECT "id" FROM "quota_profiles" WHERE "key" = 'member-default'
)
AND "metric" IN (
  'agent.requests.daily',
  'query_rewrite.llm.daily',
  'research.report_runs.daily'
);

-- Token and data-unit usage is known only after the provider/data operation.
-- Keep serving the completed result but surface an exceeded warning; rejecting
-- after the cost was already incurred would be misleading and unsafe.
UPDATE "quota_rules"
SET
  "enforcement" = 'warn',
  "updated_at" = CURRENT_TIMESTAMP
WHERE "profile_id" = (
  SELECT "id" FROM "quota_profiles" WHERE "key" = 'member-default'
)
AND "metric" IN (
  'llm.total_tokens.monthly',
  'quant.data_units.daily'
);

UPDATE "quota_profiles"
SET
  "description" = '请求前可判断的有限配额执行硬限制，结果型用量提醒；管理员保持无限。',
  "updated_at" = CURRENT_TIMESTAMP
WHERE "key" = 'member-default';
