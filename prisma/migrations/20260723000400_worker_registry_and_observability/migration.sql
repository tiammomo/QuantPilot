BEGIN;

CREATE TABLE "agent_worker_instances" (
  "id" UUID NOT NULL,
  "pool_key" TEXT NOT NULL,
  "hostname" TEXT NOT NULL,
  "process_id" INTEGER NOT NULL,
  "process_concurrency" INTEGER NOT NULL,
  "global_concurrency" INTEGER NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'running',
  "lease_expires_at" TIMESTAMP(3),
  "last_heartbeat_at" TIMESTAMP(3) NOT NULL,
  "started_at" TIMESTAMP(3) NOT NULL,
  "stopped_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "agent_worker_instances_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "agent_worker_instances_process_id_check" CHECK ("process_id" > 0),
  CONSTRAINT "agent_worker_instances_process_concurrency_check"
    CHECK ("process_concurrency" BETWEEN 1 AND 16),
  CONSTRAINT "agent_worker_instances_global_concurrency_check"
    CHECK ("global_concurrency" BETWEEN 1 AND 256),
  CONSTRAINT "agent_worker_instances_capacity_order_check"
    CHECK ("process_concurrency" <= "global_concurrency"),
  CONSTRAINT "agent_worker_instances_status_check"
    CHECK ("status" IN ('running', 'stopped', 'stale')),
  CONSTRAINT "agent_worker_instances_lease_state_check" CHECK (
    (
      "status" = 'running'
      AND "lease_expires_at" IS NOT NULL
      AND "stopped_at" IS NULL
    )
    OR
    (
      "status" IN ('stopped', 'stale')
      AND "lease_expires_at" IS NULL
      AND "stopped_at" IS NOT NULL
    )
  )
);

CREATE INDEX "agent_worker_instances_pool_key_status_lease_expires_at_idx"
  ON "agent_worker_instances"("pool_key", "status", "lease_expires_at");
CREATE INDEX "agent_worker_instances_status_lease_expires_at_idx"
  ON "agent_worker_instances"("status", "lease_expires_at");

COMMIT;
