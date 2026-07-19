CREATE TABLE "governed_knowledge_uses" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "request_id" TEXT NOT NULL,
    "context_pack_id" TEXT NOT NULL,
    "exposure_receipt_id" TEXT NOT NULL,
    "context_digest" TEXT NOT NULL,
    "policy_epoch" TEXT NOT NULL,
    "task_category" TEXT NOT NULL,
    "citations" JSONB NOT NULL,
    "usage_receipts" JSONB NOT NULL,
    "accepted_receipt_id" TEXT NOT NULL,
    "accepted_receipt_sha256" TEXT NOT NULL,
    "feedback_status" TEXT NOT NULL DEFAULT 'awaiting_feedback',
    "feedback_event_id" TEXT,
    "feedback_outcome" TEXT,
    "feedback_actor_user_id" TEXT,
    "provider_feedback_receipts" JSONB,
    "last_error_code" TEXT,
    "feedback_completed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "governed_knowledge_uses_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "governed_knowledge_uses_provider_project_id_request_id_key"
ON "governed_knowledge_uses"("provider", "project_id", "request_id");

CREATE INDEX "governed_knowledge_uses_project_id_created_at_idx"
ON "governed_knowledge_uses"("project_id", "created_at");

CREATE INDEX "governed_knowledge_uses_feedback_status_created_at_idx"
ON "governed_knowledge_uses"("feedback_status", "created_at");

ALTER TABLE "governed_knowledge_uses"
ADD CONSTRAINT "governed_knowledge_uses_project_id_fkey"
FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
