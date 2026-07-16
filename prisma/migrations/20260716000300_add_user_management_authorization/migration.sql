ALTER TABLE "auth_users"
ADD COLUMN "banned" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "ban_reason" TEXT,
ADD COLUMN "ban_expires" TIMESTAMP(3),
ADD COLUMN "must_change_password" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "last_login_at" TIMESTAMP(3),
ADD COLUMN "password_changed_at" TIMESTAMP(3);

ALTER TABLE "auth_sessions"
ADD COLUMN "impersonated_by" TEXT;

ALTER TABLE "projects"
ADD COLUMN "owner_id" TEXT;

CREATE TABLE "project_memberships" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'viewer',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "project_memberships_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "project_memberships_role_check" CHECK ("role" IN ('owner', 'editor', 'viewer'))
);

CREATE TABLE "auth_audit_events" (
    "id" TEXT NOT NULL,
    "actor_user_id" TEXT,
    "event_type" TEXT NOT NULL,
    "target_type" TEXT,
    "target_id" TEXT,
    "outcome" TEXT NOT NULL,
    "ip_address" TEXT,
    "user_agent" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "auth_audit_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "projects_owner_id_idx" ON "projects"("owner_id");
CREATE INDEX "auth_users_banned_idx" ON "auth_users"("banned");
CREATE UNIQUE INDEX "project_memberships_project_id_user_id_key" ON "project_memberships"("project_id", "user_id");
CREATE INDEX "project_memberships_user_id_idx" ON "project_memberships"("user_id");
CREATE INDEX "project_memberships_project_id_role_idx" ON "project_memberships"("project_id", "role");
CREATE INDEX "auth_audit_events_actor_user_id_created_at_idx" ON "auth_audit_events"("actor_user_id", "created_at");
CREATE INDEX "auth_audit_events_event_type_created_at_idx" ON "auth_audit_events"("event_type", "created_at");
CREATE INDEX "auth_audit_events_target_type_target_id_idx" ON "auth_audit_events"("target_type", "target_id");

ALTER TABLE "projects"
ADD CONSTRAINT "projects_owner_id_fkey"
FOREIGN KEY ("owner_id") REFERENCES "auth_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "project_memberships"
ADD CONSTRAINT "project_memberships_project_id_fkey"
FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "project_memberships"
ADD CONSTRAINT "project_memberships_user_id_fkey"
FOREIGN KEY ("user_id") REFERENCES "auth_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "auth_audit_events"
ADD CONSTRAINT "auth_audit_events_actor_user_id_fkey"
FOREIGN KEY ("actor_user_id") REFERENCES "auth_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "auth_users"
ADD CONSTRAINT "auth_users_role_check" CHECK ("role" IN ('admin', 'member'));

WITH first_admin AS (
  SELECT "id"
  FROM "auth_users"
  WHERE "role" = 'admin'
  ORDER BY "created_at" ASC, "id" ASC
  LIMIT 1
)
UPDATE "projects"
SET "owner_id" = first_admin."id"
FROM first_admin
WHERE "projects"."owner_id" IS NULL;

INSERT INTO "project_memberships" (
  "id", "project_id", "user_id", "role", "created_at", "updated_at"
)
SELECT
  'pm_' || md5("projects"."id" || ':' || "projects"."owner_id"),
  "projects"."id",
  "projects"."owner_id",
  'owner',
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "projects"
WHERE "projects"."owner_id" IS NOT NULL
ON CONFLICT ("project_id", "user_id") DO UPDATE SET
  "role" = 'owner',
  "updated_at" = CURRENT_TIMESTAMP;
