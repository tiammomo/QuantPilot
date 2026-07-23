BEGIN;

CREATE TABLE "agent_worker_slots" (
  "pool_key" TEXT NOT NULL,
  "slot_number" INTEGER NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'free',
  "active_job_id" UUID,
  "lease_owner" TEXT,
  "lease_expires_at" TIMESTAMP(3),
  "last_heartbeat_at" TIMESTAMP(3),
  "fencing_token" INTEGER NOT NULL DEFAULT 0,
  "version" INTEGER NOT NULL DEFAULT 0,
  "acquired_at" TIMESTAMP(3),
  "released_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "agent_worker_slots_pkey" PRIMARY KEY ("pool_key", "slot_number"),
  CONSTRAINT "agent_worker_slots_slot_number_check" CHECK ("slot_number" > 0),
  CONSTRAINT "agent_worker_slots_status_check" CHECK ("status" IN ('free', 'held')),
  CONSTRAINT "agent_worker_slots_fencing_token_check" CHECK ("fencing_token" >= 0),
  CONSTRAINT "agent_worker_slots_version_check" CHECK ("version" >= 0),
  CONSTRAINT "agent_worker_slots_owner_state_check" CHECK (
    (
      "status" = 'free'
      AND "active_job_id" IS NULL
      AND "lease_owner" IS NULL
      AND "lease_expires_at" IS NULL
    )
    OR
    (
      "status" = 'held'
      AND "active_job_id" IS NOT NULL
      AND "lease_owner" IS NOT NULL
      AND "lease_expires_at" IS NOT NULL
    )
  )
);

CREATE UNIQUE INDEX "agent_worker_slots_active_job_id_key"
  ON "agent_worker_slots"("active_job_id");
CREATE INDEX "agent_worker_slots_pool_key_status_lease_expires_at_idx"
  ON "agent_worker_slots"("pool_key", "status", "lease_expires_at");

INSERT INTO "quota_rules" (
  "id",
  "profile_id",
  "metric",
  "limit",
  "enforcement",
  "window_type",
  "window_seconds",
  "reservation_ttl_seconds",
  "created_at",
  "updated_at"
)
SELECT
  'quota_rule_agent_pending',
  "id",
  'agent.pending',
  4,
  'hard',
  'lifetime',
  NULL,
  3600,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "quota_profiles"
WHERE "key" = 'member-default'
ON CONFLICT ("profile_id", "metric") DO UPDATE SET
  "limit" = EXCLUDED."limit",
  "enforcement" = EXCLUDED."enforcement",
  "window_type" = EXCLUDED."window_type",
  "window_seconds" = EXCLUDED."window_seconds",
  "reservation_ttl_seconds" = EXCLUDED."reservation_ttl_seconds",
  "updated_at" = CURRENT_TIMESTAMP;

COMMIT;
