BEGIN;

CREATE TABLE "agent_tool_approvals" (
  "id" TEXT NOT NULL,
  "run_id" TEXT NOT NULL,
  "turn" INTEGER NOT NULL,
  "tool_call_id_hash" TEXT NOT NULL,
  "tool_name" TEXT NOT NULL,
  "effect" TEXT NOT NULL,
  "idempotency" TEXT NOT NULL,
  "input_hash" TEXT NOT NULL,
  "public_input" JSONB NOT NULL,
  "reason" TEXT NOT NULL,
  "allowed_decisions" TEXT[] NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "decision" TEXT,
  "edited_input" JSONB,
  "resolved_by_actor_id" TEXT,
  "resolved_by_user_id" TEXT,
  "requested_at" TIMESTAMP(3) NOT NULL,
  "expires_at" TIMESTAMP(3) NOT NULL,
  "resolved_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "agent_tool_approvals_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "agent_tool_approvals_run_id_fkey"
    FOREIGN KEY ("run_id") REFERENCES "agent_runs"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "agent_tool_approvals_resolved_by_user_id_fkey"
    FOREIGN KEY ("resolved_by_user_id") REFERENCES "auth_users"("id")
    ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "agent_tool_approvals_turn_check" CHECK ("turn" > 0),
  CONSTRAINT "agent_tool_approvals_effect_check"
    CHECK ("effect" IN ('workspace_write', 'external_write')),
  CONSTRAINT "agent_tool_approvals_idempotency_check"
    CHECK ("idempotency" IN ('intrinsic', 'operation_key', 'reconcile_required')),
  CONSTRAINT "agent_tool_approvals_status_check"
    CHECK ("status" IN ('pending', 'approved', 'edited', 'rejected', 'expired')),
  CONSTRAINT "agent_tool_approvals_decision_check"
    CHECK ("decision" IS NULL OR "decision" IN ('approve', 'edit', 'reject')),
  CONSTRAINT "agent_tool_approvals_time_check"
    CHECK ("expires_at" > "requested_at"),
  CONSTRAINT "agent_tool_approvals_resolution_check" CHECK (
    (
      "status" = 'pending'
      AND "decision" IS NULL
      AND "edited_input" IS NULL
      AND "resolved_by_actor_id" IS NULL
      AND "resolved_by_user_id" IS NULL
      AND "resolved_at" IS NULL
    )
    OR
    (
      "status" = 'expired'
      AND "decision" IS NULL
      AND "edited_input" IS NULL
      AND "resolved_by_actor_id" IS NULL
      AND "resolved_by_user_id" IS NULL
      AND "resolved_at" IS NOT NULL
    )
    OR
    (
      "status" = 'approved'
      AND "decision" = 'approve'
      AND "edited_input" IS NULL
      AND "resolved_by_actor_id" IS NOT NULL
      AND "resolved_at" IS NOT NULL
    )
    OR
    (
      "status" = 'edited'
      AND "decision" = 'edit'
      AND "edited_input" IS NOT NULL
      AND "resolved_by_actor_id" IS NOT NULL
      AND "resolved_at" IS NOT NULL
    )
    OR
    (
      "status" = 'rejected'
      AND "decision" = 'reject'
      AND "edited_input" IS NULL
      AND "resolved_by_actor_id" IS NOT NULL
      AND "resolved_at" IS NOT NULL
    )
  )
);

CREATE INDEX "agent_tool_approvals_run_id_requested_at_idx"
  ON "agent_tool_approvals"("run_id", "requested_at");
CREATE INDEX "agent_tool_approvals_status_expires_at_idx"
  ON "agent_tool_approvals"("status", "expires_at");
CREATE INDEX "agent_tool_approvals_resolved_by_actor_id_resolved_at_idx"
  ON "agent_tool_approvals"("resolved_by_actor_id", "resolved_at");
CREATE INDEX "agent_tool_approvals_resolved_by_user_id_resolved_at_idx"
  ON "agent_tool_approvals"("resolved_by_user_id", "resolved_at");

COMMIT;
