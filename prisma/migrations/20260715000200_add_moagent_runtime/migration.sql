-- Additive durable MoAgent runtime schema. This migration does not drop,
-- truncate, rename, or rewrite existing application data.

BEGIN;

-- CreateTable
CREATE TABLE "agent_runs" (
    "id" TEXT NOT NULL,
    "run_instance_id" UUID NOT NULL,
    "project_id" TEXT NOT NULL,
    "request_id" TEXT,
    "workspace_key" TEXT NOT NULL DEFAULT 'legacy:unknown',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "lease_owner" TEXT,
    "lease_expires_at" TIMESTAMP(3),
    "last_heartbeat_at" TIMESTAMP(3),
    "fencing_token" INTEGER NOT NULL DEFAULT 0,
    "workspace_fencing_token" INTEGER NOT NULL DEFAULT 0,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "framework_version" TEXT NOT NULL,
    "profile_hash" TEXT NOT NULL,
    "prompt_hash" TEXT NOT NULL,
    "tool_hash" TEXT NOT NULL,
    "skill_hash" TEXT NOT NULL,
    "workspace_hash" TEXT NOT NULL,
    "turn_count" INTEGER NOT NULL DEFAULT 0,
    "input_tokens" INTEGER NOT NULL DEFAULT 0,
    "output_tokens" INTEGER NOT NULL DEFAULT 0,
    "total_tokens" INTEGER NOT NULL DEFAULT 0,
    "cached_input_tokens" INTEGER NOT NULL DEFAULT 0,
    "cache_miss_input_tokens" INTEGER NOT NULL DEFAULT 0,
    "reasoning_tokens" INTEGER NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 0,
    "last_event_sequence" INTEGER NOT NULL DEFAULT 0,
    "latest_checkpoint_sequence" INTEGER,
    "error_code" TEXT,
    "error_message" TEXT,
    "started_at" TIMESTAMP(3),
    "finished_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_workspace_leases" (
    "project_id" TEXT NOT NULL,
    "workspace_key" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'free',
    "active_run_id" TEXT,
    "lease_owner" TEXT,
    "lease_expires_at" TIMESTAMP(3),
    "last_heartbeat_at" TIMESTAMP(3),
    "fencing_token" INTEGER NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 0,
    "acquired_at" TIMESTAMP(3),
    "released_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_workspace_leases_pkey" PRIMARY KEY ("project_id")
);

-- CreateTable
CREATE TABLE "agent_events" (
    "id" TEXT NOT NULL,
    "event_id" TEXT NOT NULL,
    "run_id" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "event_type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "occurred_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_checkpoints" (
    "id" TEXT NOT NULL,
    "run_id" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "turn" INTEGER NOT NULL,
    "boundary" TEXT NOT NULL,
    "recovery_mode" TEXT NOT NULL DEFAULT 'replan_required',
    "public_state" JSONB NOT NULL,
    "opaque_state" TEXT,
    "opaque_codec" TEXT,
    "state_hash" TEXT NOT NULL,
    "state_version" INTEGER NOT NULL,
    "fencing_token" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_checkpoints_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_tool_executions" (
    "id" TEXT NOT NULL,
    "run_id" TEXT NOT NULL,
    "operation_id" TEXT NOT NULL,
    "tool_call_id" TEXT NOT NULL,
    "tool_name" TEXT NOT NULL,
    "input_hash" TEXT NOT NULL,
    "effect" TEXT NOT NULL,
    "idempotency" TEXT NOT NULL,
    "idempotency_key" TEXT,
    "status" TEXT NOT NULL DEFAULT 'prepared',
    "result_receipt" JSONB,
    "pre_state_hash" TEXT,
    "post_state_hash" TEXT,
    "error_code" TEXT,
    "error_message" TEXT,
    "fencing_token" INTEGER NOT NULL,
    "workspace_fencing_token" INTEGER NOT NULL DEFAULT 0,
    "prepared_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_tool_executions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "agent_runs_run_instance_id_key" ON "agent_runs"("run_instance_id");

-- CreateIndex
CREATE INDEX "agent_runs_project_id_created_at_idx" ON "agent_runs"("project_id", "created_at");

-- CreateIndex
CREATE INDEX "agent_runs_request_id_created_at_idx" ON "agent_runs"("request_id", "created_at");

-- CreateIndex
CREATE INDEX "agent_runs_status_lease_expires_at_idx" ON "agent_runs"("status", "lease_expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "agent_workspace_leases_workspace_key_key" ON "agent_workspace_leases"("workspace_key");

-- CreateIndex
CREATE UNIQUE INDEX "agent_workspace_leases_active_run_id_key" ON "agent_workspace_leases"("active_run_id");

-- CreateIndex
CREATE INDEX "agent_workspace_leases_status_lease_expires_at_idx" ON "agent_workspace_leases"("status", "lease_expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "agent_events_event_id_key" ON "agent_events"("event_id");

-- CreateIndex
CREATE INDEX "agent_events_run_id_created_at_idx" ON "agent_events"("run_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "agent_events_run_id_sequence_key" ON "agent_events"("run_id", "sequence");

-- CreateIndex
CREATE INDEX "agent_checkpoints_run_id_created_at_idx" ON "agent_checkpoints"("run_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "agent_checkpoints_run_id_sequence_key" ON "agent_checkpoints"("run_id", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "agent_tool_executions_operation_id_key" ON "agent_tool_executions"("operation_id");

-- CreateIndex
CREATE INDEX "agent_tool_executions_run_id_status_idx" ON "agent_tool_executions"("run_id", "status");

-- CreateIndex
CREATE INDEX "agent_tool_executions_status_updated_at_idx" ON "agent_tool_executions"("status", "updated_at");

-- CreateIndex
CREATE UNIQUE INDEX "user_requests_id_project_id_key" ON "user_requests"("id", "project_id");

-- AddForeignKey
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_request_id_project_id_fkey" FOREIGN KEY ("request_id", "project_id") REFERENCES "user_requests"("id", "project_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_workspace_leases" ADD CONSTRAINT "agent_workspace_leases_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_events" ADD CONSTRAINT "agent_events_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "agent_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_checkpoints" ADD CONSTRAINT "agent_checkpoints_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "agent_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_tool_executions" ADD CONSTRAINT "agent_tool_executions_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "agent_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

COMMIT;
