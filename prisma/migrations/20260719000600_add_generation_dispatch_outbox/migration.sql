-- Durable dispatch facts and transactional lifecycle outbox for MoAgent.
-- Provider-private sessions remain deliberately non-resumable; expired
-- attempts are fenced and closed with replan-required semantics.

CREATE TABLE "agent_generation_jobs" (
  "id" UUID NOT NULL,
  "project_id" TEXT NOT NULL,
  "request_id" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "stage" TEXT NOT NULL DEFAULT 'agent_execution',
  "execution_envelope" JSONB NOT NULL,
  "instruction_hash" TEXT NOT NULL,
  "instruction_preview" TEXT NOT NULL,
  "cli_preference" TEXT,
  "selected_model" TEXT,
  "attempt_count" INTEGER NOT NULL DEFAULT 0,
  "max_attempts" INTEGER NOT NULL DEFAULT 1,
  "available_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lease_owner" TEXT,
  "lease_expires_at" TIMESTAMP(3),
  "last_heartbeat_at" TIMESTAMP(3),
  "fencing_token" INTEGER NOT NULL DEFAULT 0,
  "version" INTEGER NOT NULL DEFAULT 0,
  "event_sequence" INTEGER NOT NULL DEFAULT 0,
  "error_code" TEXT,
  "error_message" TEXT,
  "queued_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "started_at" TIMESTAMP(3),
  "completed_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "agent_generation_jobs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "agent_generation_jobs_status_check" CHECK (
    "status" IN ('pending', 'running', 'retry_wait', 'completed', 'failed', 'cancelled', 'interrupted')
  ),
  CONSTRAINT "agent_generation_jobs_stage_check" CHECK (
    "stage" IN ('agent_execution', 'automatic_validation', 'completed')
  ),
  CONSTRAINT "agent_generation_jobs_owner_pair_check" CHECK (
    ("status" = 'running' AND "lease_owner" IS NOT NULL AND "lease_expires_at" IS NOT NULL)
    OR
    ("status" <> 'running' AND "lease_owner" IS NULL AND "lease_expires_at" IS NULL)
  ),
  CONSTRAINT "agent_generation_jobs_attempt_count_check" CHECK (
    "attempt_count" >= 0 AND "max_attempts" > 0 AND "attempt_count" <= "max_attempts"
  ),
  CONSTRAINT "agent_generation_jobs_fencing_token_check" CHECK ("fencing_token" >= 0),
  CONSTRAINT "agent_generation_jobs_event_sequence_check" CHECK ("event_sequence" >= 0)
);

CREATE UNIQUE INDEX "agent_generation_jobs_request_id_project_id_key"
  ON "agent_generation_jobs"("request_id", "project_id");
CREATE INDEX "agent_generation_jobs_project_id_queued_at_idx"
  ON "agent_generation_jobs"("project_id", "queued_at");
CREATE INDEX "agent_generation_jobs_status_available_at_idx"
  ON "agent_generation_jobs"("status", "available_at");
CREATE INDEX "agent_generation_jobs_status_lease_expires_at_idx"
  ON "agent_generation_jobs"("status", "lease_expires_at");
CREATE UNIQUE INDEX "agent_generation_jobs_one_running_per_project_idx"
  ON "agent_generation_jobs"("project_id") WHERE "status" = 'running';

ALTER TABLE "agent_generation_jobs"
  ADD CONSTRAINT "agent_generation_jobs_project_id_fkey"
  FOREIGN KEY ("project_id") REFERENCES "projects"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "agent_generation_jobs"
  ADD CONSTRAINT "agent_generation_jobs_request_id_project_id_fkey"
  FOREIGN KEY ("request_id", "project_id") REFERENCES "user_requests"("id", "project_id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "agent_generation_outbox_events" (
  "id" UUID NOT NULL,
  "job_id" UUID NOT NULL,
  "project_id" TEXT NOT NULL,
  "request_id" TEXT NOT NULL,
  "sequence" INTEGER NOT NULL,
  "event_type" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "occurred_at" TIMESTAMP(3) NOT NULL,
  "published_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "agent_generation_outbox_events_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "agent_generation_outbox_events_sequence_check" CHECK ("sequence" > 0)
);

CREATE UNIQUE INDEX "agent_generation_outbox_events_job_id_sequence_key"
  ON "agent_generation_outbox_events"("job_id", "sequence");
CREATE INDEX "agent_generation_outbox_events_project_id_created_at_idx"
  ON "agent_generation_outbox_events"("project_id", "created_at");
CREATE INDEX "agent_generation_outbox_events_published_at_created_at_idx"
  ON "agent_generation_outbox_events"("published_at", "created_at");

ALTER TABLE "agent_generation_outbox_events"
  ADD CONSTRAINT "agent_generation_outbox_events_job_id_fkey"
  FOREIGN KEY ("job_id") REFERENCES "agent_generation_jobs"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
