-- Serialize the outer MoAgent orchestration stages across application
-- processes. Fine-grained AgentRun and Mission fencing remains unchanged.

CREATE TABLE "agent_generation_leases" (
  "project_id" TEXT NOT NULL,
  "active_request_id" TEXT,
  "operation_id" TEXT,
  "stage" TEXT,
  "status" TEXT NOT NULL DEFAULT 'free',
  "lease_owner" TEXT,
  "lease_expires_at" TIMESTAMP(3),
  "last_heartbeat_at" TIMESTAMP(3),
  "fencing_token" INTEGER NOT NULL DEFAULT 0,
  "version" INTEGER NOT NULL DEFAULT 0,
  "acquired_at" TIMESTAMP(3),
  "released_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "agent_generation_leases_pkey" PRIMARY KEY ("project_id"),
  CONSTRAINT "agent_generation_leases_status_check"
    CHECK ("status" IN ('free', 'held')),
  CONSTRAINT "agent_generation_leases_owner_pair_check"
    CHECK (
      ("status" = 'free' AND "lease_owner" IS NULL AND "lease_expires_at" IS NULL
        AND "operation_id" IS NULL AND "stage" IS NULL AND "active_request_id" IS NULL)
      OR
      ("status" = 'held' AND "lease_owner" IS NOT NULL AND "lease_expires_at" IS NOT NULL
        AND "operation_id" IS NOT NULL AND "stage" IS NOT NULL)
    ),
  CONSTRAINT "agent_generation_leases_fencing_token_check"
    CHECK ("fencing_token" >= 0)
);

CREATE INDEX "agent_generation_leases_status_lease_expires_at_idx"
  ON "agent_generation_leases"("status", "lease_expires_at");

CREATE INDEX "agent_generation_leases_active_request_id_idx"
  ON "agent_generation_leases"("active_request_id");

ALTER TABLE "agent_generation_leases"
  ADD CONSTRAINT "agent_generation_leases_project_id_fkey"
  FOREIGN KEY ("project_id") REFERENCES "projects"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "agent_generation_leases"
  ADD CONSTRAINT "agent_generation_leases_active_request_id_project_id_fkey"
  FOREIGN KEY ("active_request_id", "project_id")
  REFERENCES "user_requests"("id", "project_id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
