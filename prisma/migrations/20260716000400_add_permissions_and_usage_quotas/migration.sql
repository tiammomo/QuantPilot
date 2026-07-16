BEGIN;

CREATE TABLE "permission_profiles" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "permission_profiles_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "permission_profile_grants" (
    "id" TEXT NOT NULL,
    "profile_id" TEXT NOT NULL,
    "permission_key" TEXT NOT NULL,
    "effect" TEXT NOT NULL DEFAULT 'allow',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "permission_profile_grants_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "permission_profile_grants_effect_check" CHECK ("effect" IN ('allow', 'deny')),
    CONSTRAINT "permission_profile_grants_key_check" CHECK (char_length("permission_key") BETWEEN 1 AND 160)
);

CREATE TABLE "quota_profiles" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "quota_profiles_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "quota_rules" (
    "id" TEXT NOT NULL,
    "profile_id" TEXT NOT NULL,
    "metric" TEXT NOT NULL,
    "limit" BIGINT NOT NULL,
    "enforcement" TEXT NOT NULL DEFAULT 'observe',
    "window_type" TEXT NOT NULL DEFAULT 'month',
    "window_seconds" INTEGER,
    "reservation_ttl_seconds" INTEGER NOT NULL DEFAULT 900,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "quota_rules_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "quota_rules_limit_check" CHECK ("limit" > 0),
    CONSTRAINT "quota_rules_enforcement_check" CHECK ("enforcement" IN ('observe', 'warn', 'hard')),
    CONSTRAINT "quota_rules_window_type_check" CHECK ("window_type" IN ('minute', 'hour', 'day', 'month', 'fixed', 'lifetime')),
    CONSTRAINT "quota_rules_window_seconds_check" CHECK (
      ("window_type" = 'fixed' AND "window_seconds" BETWEEN 1 AND 31536000)
      OR ("window_type" <> 'fixed' AND "window_seconds" IS NULL)
    ),
    CONSTRAINT "quota_rules_reservation_ttl_check" CHECK ("reservation_ttl_seconds" BETWEEN 1 AND 86400),
    CONSTRAINT "quota_rules_metric_check" CHECK (char_length("metric") BETWEEN 1 AND 160)
);

ALTER TABLE "auth_users"
ADD COLUMN "permission_profile_id" TEXT,
ADD COLUMN "quota_profile_id" TEXT,
ADD COLUMN "access_version" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "user_requests"
ADD COLUMN "actor_user_id" TEXT;

ALTER TABLE "agent_runs"
ADD COLUMN "actor_user_id" TEXT;

ALTER TABLE "auth_users"
ADD CONSTRAINT "auth_users_access_version_check" CHECK ("access_version" >= 0);

CREATE TABLE "user_permission_overrides" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "permission_key" TEXT NOT NULL,
    "effect" TEXT NOT NULL,
    "reason" TEXT,
    "expires_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "user_permission_overrides_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "user_permission_overrides_effect_check" CHECK ("effect" IN ('allow', 'deny')),
    CONSTRAINT "user_permission_overrides_key_check" CHECK (char_length("permission_key") BETWEEN 1 AND 160)
);

CREATE TABLE "user_quota_overrides" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "metric" TEXT NOT NULL,
    "is_unlimited" BOOLEAN NOT NULL DEFAULT false,
    "limit" BIGINT,
    "enforcement" TEXT NOT NULL DEFAULT 'observe',
    "window_type" TEXT NOT NULL DEFAULT 'month',
    "window_seconds" INTEGER,
    "reservation_ttl_seconds" INTEGER NOT NULL DEFAULT 900,
    "reason" TEXT,
    "expires_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "user_quota_overrides_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "user_quota_overrides_limit_check" CHECK (
      ("is_unlimited" = true AND "limit" IS NULL)
      OR ("is_unlimited" = false AND "limit" > 0)
    ),
    CONSTRAINT "user_quota_overrides_enforcement_check" CHECK ("enforcement" IN ('observe', 'warn', 'hard')),
    CONSTRAINT "user_quota_overrides_window_type_check" CHECK ("window_type" IN ('minute', 'hour', 'day', 'month', 'fixed', 'lifetime')),
    CONSTRAINT "user_quota_overrides_window_seconds_check" CHECK (
      ("window_type" = 'fixed' AND "window_seconds" BETWEEN 1 AND 31536000)
      OR ("window_type" <> 'fixed' AND "window_seconds" IS NULL)
    ),
    CONSTRAINT "user_quota_overrides_reservation_ttl_check" CHECK ("reservation_ttl_seconds" BETWEEN 1 AND 86400),
    CONSTRAINT "user_quota_overrides_metric_check" CHECK (char_length("metric") BETWEEN 1 AND 160)
);

CREATE TABLE "usage_buckets" (
    "id" TEXT NOT NULL,
    "actor_user_id" TEXT NOT NULL,
    "metric" TEXT NOT NULL,
    "window_start" TIMESTAMP(3) NOT NULL,
    "window_end" TIMESTAMP(3) NOT NULL,
    "used" BIGINT NOT NULL DEFAULT 0,
    "reserved" BIGINT NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "usage_buckets_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "usage_buckets_quantity_check" CHECK ("used" >= 0 AND "reserved" >= 0),
    CONSTRAINT "usage_buckets_window_check" CHECK ("window_end" > "window_start"),
    CONSTRAINT "usage_buckets_version_check" CHECK ("version" >= 0),
    CONSTRAINT "usage_buckets_metric_check" CHECK (char_length("metric") BETWEEN 1 AND 160)
);

CREATE TABLE "quota_reservations" (
    "id" TEXT NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "actor_user_id" TEXT NOT NULL,
    "project_id" TEXT,
    "bucket_id" TEXT NOT NULL,
    "metric" TEXT NOT NULL,
    "reserved_quantity" BIGINT NOT NULL,
    "committed_quantity" BIGINT NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'active',
    "policy_limit" BIGINT,
    "policy_enforcement" TEXT NOT NULL,
    "policy_window_type" TEXT NOT NULL,
    "enforcement_exempt" BOOLEAN NOT NULL DEFAULT false,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "settled_at" TIMESTAMP(3),
    "released_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "quota_reservations_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "quota_reservations_reserved_quantity_check" CHECK ("reserved_quantity" > 0),
    CONSTRAINT "quota_reservations_committed_quantity_check" CHECK ("committed_quantity" >= 0),
    CONSTRAINT "quota_reservations_status_check" CHECK ("status" IN ('active', 'settled', 'released', 'expired')),
    CONSTRAINT "quota_reservations_policy_limit_check" CHECK ("policy_limit" IS NULL OR "policy_limit" > 0),
    CONSTRAINT "quota_reservations_enforcement_check" CHECK ("policy_enforcement" IN ('observe', 'warn', 'hard')),
    CONSTRAINT "quota_reservations_window_type_check" CHECK ("policy_window_type" IN ('minute', 'hour', 'day', 'month', 'fixed', 'lifetime')),
    CONSTRAINT "quota_reservations_metric_check" CHECK (char_length("metric") BETWEEN 1 AND 160)
);

CREATE TABLE "usage_events" (
    "id" TEXT NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "actor_user_id" TEXT,
    "project_id" TEXT,
    "reservation_id" TEXT,
    "bucket_id" TEXT,
    "metric" TEXT NOT NULL,
    "quantity" BIGINT NOT NULL,
    "source_type" TEXT NOT NULL,
    "source_id" TEXT,
    "enforcement_exempt" BOOLEAN NOT NULL DEFAULT false,
    "occurred_at" TIMESTAMP(3) NOT NULL,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "usage_events_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "usage_events_metric_check" CHECK (char_length("metric") BETWEEN 1 AND 160),
    CONSTRAINT "usage_events_source_type_check" CHECK (char_length("source_type") BETWEEN 1 AND 100)
);

CREATE UNIQUE INDEX "permission_profiles_key_key" ON "permission_profiles"("key");
CREATE UNIQUE INDEX "permission_profiles_one_default_key" ON "permission_profiles"(("is_default")) WHERE "is_default" = true;
CREATE INDEX "permission_profiles_is_default_idx" ON "permission_profiles"("is_default");
CREATE UNIQUE INDEX "permission_profile_grants_profile_id_permission_key_key" ON "permission_profile_grants"("profile_id", "permission_key");
CREATE INDEX "permission_profile_grants_permission_key_effect_idx" ON "permission_profile_grants"("permission_key", "effect");
CREATE UNIQUE INDEX "quota_profiles_key_key" ON "quota_profiles"("key");
CREATE UNIQUE INDEX "quota_profiles_one_default_key" ON "quota_profiles"(("is_default")) WHERE "is_default" = true;
CREATE INDEX "quota_profiles_is_default_idx" ON "quota_profiles"("is_default");
CREATE UNIQUE INDEX "quota_rules_profile_id_metric_key" ON "quota_rules"("profile_id", "metric");
CREATE INDEX "quota_rules_metric_enforcement_idx" ON "quota_rules"("metric", "enforcement");
CREATE INDEX "auth_users_permission_profile_id_idx" ON "auth_users"("permission_profile_id");
CREATE INDEX "auth_users_quota_profile_id_idx" ON "auth_users"("quota_profile_id");
CREATE INDEX "user_requests_actor_user_id_created_at_idx" ON "user_requests"("actor_user_id", "created_at");
CREATE INDEX "agent_runs_actor_user_id_created_at_idx" ON "agent_runs"("actor_user_id", "created_at");
CREATE UNIQUE INDEX "user_permission_overrides_user_id_permission_key_key" ON "user_permission_overrides"("user_id", "permission_key");
CREATE INDEX "user_permission_overrides_permission_key_effect_idx" ON "user_permission_overrides"("permission_key", "effect");
CREATE INDEX "user_permission_overrides_expires_at_idx" ON "user_permission_overrides"("expires_at");
CREATE UNIQUE INDEX "user_quota_overrides_user_id_metric_key" ON "user_quota_overrides"("user_id", "metric");
CREATE INDEX "user_quota_overrides_metric_enforcement_idx" ON "user_quota_overrides"("metric", "enforcement");
CREATE INDEX "user_quota_overrides_expires_at_idx" ON "user_quota_overrides"("expires_at");
CREATE UNIQUE INDEX "usage_buckets_actor_user_id_metric_window_start_window_end_key" ON "usage_buckets"("actor_user_id", "metric", "window_start", "window_end");
CREATE INDEX "usage_buckets_metric_window_start_window_end_idx" ON "usage_buckets"("metric", "window_start", "window_end");
CREATE INDEX "usage_buckets_actor_user_id_window_end_idx" ON "usage_buckets"("actor_user_id", "window_end");
CREATE UNIQUE INDEX "quota_reservations_idempotency_key_key" ON "quota_reservations"("idempotency_key");
CREATE INDEX "quota_reservations_actor_user_id_metric_created_at_idx" ON "quota_reservations"("actor_user_id", "metric", "created_at");
CREATE INDEX "quota_reservations_status_expires_at_idx" ON "quota_reservations"("status", "expires_at");
CREATE INDEX "quota_reservations_project_id_idx" ON "quota_reservations"("project_id");
CREATE UNIQUE INDEX "usage_events_idempotency_key_key" ON "usage_events"("idempotency_key");
CREATE UNIQUE INDEX "usage_events_reservation_id_key" ON "usage_events"("reservation_id");
CREATE INDEX "usage_events_actor_user_id_metric_occurred_at_idx" ON "usage_events"("actor_user_id", "metric", "occurred_at");
CREATE INDEX "usage_events_project_id_occurred_at_idx" ON "usage_events"("project_id", "occurred_at");
CREATE INDEX "usage_events_metric_occurred_at_idx" ON "usage_events"("metric", "occurred_at");
CREATE INDEX "usage_events_source_type_source_id_idx" ON "usage_events"("source_type", "source_id");
CREATE INDEX "usage_events_bucket_id_idx" ON "usage_events"("bucket_id");

ALTER TABLE "permission_profile_grants"
ADD CONSTRAINT "permission_profile_grants_profile_id_fkey"
FOREIGN KEY ("profile_id") REFERENCES "permission_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "quota_rules"
ADD CONSTRAINT "quota_rules_profile_id_fkey"
FOREIGN KEY ("profile_id") REFERENCES "quota_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "auth_users"
ADD CONSTRAINT "auth_users_permission_profile_id_fkey"
FOREIGN KEY ("permission_profile_id") REFERENCES "permission_profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "auth_users"
ADD CONSTRAINT "auth_users_quota_profile_id_fkey"
FOREIGN KEY ("quota_profile_id") REFERENCES "quota_profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "user_requests"
ADD CONSTRAINT "user_requests_actor_user_id_fkey"
FOREIGN KEY ("actor_user_id") REFERENCES "auth_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "agent_runs"
ADD CONSTRAINT "agent_runs_actor_user_id_fkey"
FOREIGN KEY ("actor_user_id") REFERENCES "auth_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "user_permission_overrides"
ADD CONSTRAINT "user_permission_overrides_user_id_fkey"
FOREIGN KEY ("user_id") REFERENCES "auth_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "user_quota_overrides"
ADD CONSTRAINT "user_quota_overrides_user_id_fkey"
FOREIGN KEY ("user_id") REFERENCES "auth_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "usage_buckets"
ADD CONSTRAINT "usage_buckets_actor_user_id_fkey"
FOREIGN KEY ("actor_user_id") REFERENCES "auth_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "quota_reservations"
ADD CONSTRAINT "quota_reservations_actor_user_id_fkey"
FOREIGN KEY ("actor_user_id") REFERENCES "auth_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "quota_reservations"
ADD CONSTRAINT "quota_reservations_project_id_fkey"
FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "quota_reservations"
ADD CONSTRAINT "quota_reservations_bucket_id_fkey"
FOREIGN KEY ("bucket_id") REFERENCES "usage_buckets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "usage_events"
ADD CONSTRAINT "usage_events_actor_user_id_fkey"
FOREIGN KEY ("actor_user_id") REFERENCES "auth_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "usage_events"
ADD CONSTRAINT "usage_events_project_id_fkey"
FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "usage_events"
ADD CONSTRAINT "usage_events_reservation_id_fkey"
FOREIGN KEY ("reservation_id") REFERENCES "quota_reservations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "usage_events"
ADD CONSTRAINT "usage_events_bucket_id_fkey"
FOREIGN KEY ("bucket_id") REFERENCES "usage_buckets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

INSERT INTO "permission_profiles" (
  "id", "key", "name", "description", "is_default", "created_at", "updated_at"
) VALUES
  (
    'permission_profile_member_default',
    'member-default',
    '标准研究员',
    '普通成员的标准研究能力。项目内的最终权限仍受 owner/editor/viewer 角色约束。',
    true,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
  ),
  (
    'permission_profile_readonly_default',
    'readonly-default',
    '只读研究员',
    '只能读取已授权项目、源码、量化数据和研究报告。',
    false,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
  );

INSERT INTO "permission_profile_grants" (
  "id", "profile_id", "permission_key", "effect", "created_at", "updated_at"
)
SELECT
  'permission_grant_' || md5(permission_key),
  'permission_profile_member_default',
  permission_key,
  'allow',
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM unnest(ARRAY[
  'project.create',
  'project.read',
  'project.update',
  'project.delete',
  'project.members.manage',
  'project.source.read',
  'project.source.write',
  'project.secrets.read',
  'project.secrets.write',
  'project.services.read',
  'project.services.manage',
  'project.deploy',
  'agent.run',
  'agent.cancel',
  'quant.data.read',
  'quant.query.rewrite.llm',
  'quant.strategy.run',
  'research.report.read',
  'research.report.run'
]) AS permission_key;

INSERT INTO "permission_profile_grants" (
  "id", "profile_id", "permission_key", "effect", "created_at", "updated_at"
)
SELECT
  'readonly_permission_grant_' || md5(permission_key),
  'permission_profile_readonly_default',
  permission_key,
  'allow',
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM unnest(ARRAY[
  'project.read',
  'project.source.read',
  'quant.data.read',
  'research.report.read'
]) AS permission_key;

INSERT INTO "quota_profiles" (
  "id", "key", "name", "description", "is_default", "created_at", "updated_at"
) VALUES (
  'quota_profile_member_default',
  'member-default',
  '普通成员',
  '确定性资源使用硬限制；成本型指标先观察真实分布再逐步启用硬限制。',
  true,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
);

INSERT INTO "quota_rules" (
  "id", "profile_id", "metric", "limit", "enforcement", "window_type",
  "window_seconds", "reservation_ttl_seconds", "created_at", "updated_at"
) VALUES
  ('quota_rule_projects_owned', 'quota_profile_member_default', 'projects.owned', 10, 'hard', 'lifetime', NULL, 3600, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('quota_rule_agent_concurrent', 'quota_profile_member_default', 'agent.concurrent', 2, 'hard', 'lifetime', NULL, 3600, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('quota_rule_agent_requests_daily', 'quota_profile_member_default', 'agent.requests.daily', 100, 'observe', 'day', NULL, 900, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('quota_rule_llm_tokens_monthly', 'quota_profile_member_default', 'llm.total_tokens.monthly', 2000000, 'observe', 'month', NULL, 3600, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('quota_rule_query_rewrite_daily', 'quota_profile_member_default', 'query_rewrite.llm.daily', 200, 'observe', 'day', NULL, 900, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('quota_rule_quant_data_daily', 'quota_profile_member_default', 'quant.data_units.daily', 2000, 'observe', 'day', NULL, 900, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('quota_rule_research_report_run_daily', 'quota_profile_member_default', 'research.report_runs.daily', 20, 'observe', 'day', NULL, 3600, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('quota_rule_research_report_send_daily', 'quota_profile_member_default', 'research.report_sends.daily', 10, 'hard', 'day', NULL, 3600, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

UPDATE "auth_users"
SET
  "permission_profile_id" = 'permission_profile_member_default',
  "quota_profile_id" = 'quota_profile_member_default'
WHERE "role" = 'member';

-- Establish the lifetime project allocation counter from existing ownership.
-- Historical rows are intentionally aggregated per actor; future creates and
-- deletes append their own idempotent usage adjustments.
INSERT INTO "usage_buckets" (
  "id", "actor_user_id", "metric", "window_start", "window_end",
  "used", "reserved", "version", "created_at", "updated_at"
)
SELECT
  'usage_bucket_projects_owned_' || md5(projects."owner_id"),
  projects."owner_id",
  'projects.owned',
  TIMESTAMP '1970-01-01 00:00:00.000',
  TIMESTAMP '9999-12-31 23:59:59.999',
  COUNT(*)::bigint,
  0,
  0,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "projects" projects
WHERE projects."owner_id" IS NOT NULL
GROUP BY projects."owner_id";

INSERT INTO "usage_events" (
  "id", "idempotency_key", "actor_user_id", "project_id", "reservation_id",
  "bucket_id", "metric", "quantity", "source_type", "source_id", "enforcement_exempt",
  "occurred_at", "metadata", "created_at"
)
SELECT
  'usage_event_projects_owned_' || md5(projects."owner_id"),
  'migration:projects-owned:' || projects."owner_id",
  projects."owner_id",
  NULL,
  NULL,
  'usage_bucket_projects_owned_' || md5(projects."owner_id"),
  'projects.owned',
  COUNT(*)::bigint,
  'migration_backfill',
  projects."owner_id",
  auth_users."role" = 'admin',
  CURRENT_TIMESTAMP,
  jsonb_build_object('aggregated', true, 'schemaMigration', '20260716000400'),
  CURRENT_TIMESTAMP
FROM "projects" projects
JOIN "auth_users" auth_users ON auth_users."id" = projects."owner_id"
WHERE projects."owner_id" IS NOT NULL
GROUP BY projects."owner_id", auth_users."role";

-- Durable replay ledger for explicitly idempotent, potentially expensive API
-- operations. Request bodies are represented by hashes and cached response
-- documents are bounded by the application layer.
CREATE TABLE "api_idempotency_operations" (
  "id" TEXT NOT NULL,
  "scope" TEXT NOT NULL,
  "actor_key" TEXT NOT NULL,
  "idempotency_key_hash" TEXT NOT NULL,
  "payload_hash" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'running',
  "attempt" INTEGER NOT NULL DEFAULT 1,
  "lease_expires_at" TIMESTAMP(3) NOT NULL,
  "response_status" INTEGER,
  "response_body" JSONB,
  "response_bytes" INTEGER,
  "quota_reservation_id" TEXT,
  "quota_settlement" JSONB,
  "quota_accounted_at" TIMESTAMP(3),
  "error_code" TEXT,
  "error_message" TEXT,
  "completed_at" TIMESTAMP(3),
  "retention_expires_at" TIMESTAMP(3) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "api_idempotency_operations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "api_idempotency_operations_status_check"
    CHECK ("status" IN ('running', 'completed', 'failed')),
  CONSTRAINT "api_idempotency_operations_attempt_check"
    CHECK ("attempt" > 0),
  CONSTRAINT "api_idempotency_operations_response_status_check"
    CHECK ("response_status" IS NULL OR "response_status" BETWEEN 100 AND 599),
  CONSTRAINT "api_idempotency_operations_response_bytes_check"
    CHECK ("response_bytes" IS NULL OR "response_bytes" >= 0),
  CONSTRAINT "api_idempotency_operations_quota_reservation_id_fkey"
    FOREIGN KEY ("quota_reservation_id") REFERENCES "quota_reservations"("id")
    ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "api_idempotency_operations_scope_actor_key_idempotency_key_hash_key"
  ON "api_idempotency_operations"("scope", "actor_key", "idempotency_key_hash");
CREATE INDEX "api_idempotency_operations_status_lease_expires_at_idx"
  ON "api_idempotency_operations"("status", "lease_expires_at");
CREATE INDEX "api_idempotency_operations_retention_expires_at_idx"
  ON "api_idempotency_operations"("retention_expires_at");
CREATE UNIQUE INDEX "api_idempotency_operations_quota_reservation_id_key"
  ON "api_idempotency_operations"("quota_reservation_id");
CREATE INDEX "api_idempotency_operations_status_quota_accounted_at_idx"
  ON "api_idempotency_operations"("status", "quota_accounted_at");

-- Reserve each real notification delivery before contacting its webhook. A
-- nullable unique key preserves existing rows while making retries at-most-once
-- per report/channel/idempotency key, even if response persistence fails.
ALTER TABLE "notification_deliveries" ADD COLUMN "idempotency_key" TEXT;
CREATE UNIQUE INDEX "notification_deliveries_idempotency_key_key"
  ON "notification_deliveries"("idempotency_key");

COMMIT;
