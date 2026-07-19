ALTER TABLE "external_memory_uses"
ADD COLUMN "status" TEXT NOT NULL DEFAULT 'exposed',
ADD COLUMN "exposed_at" TIMESTAMP(3);

UPDATE "external_memory_uses"
SET
    "status" = CASE
        WHEN jsonb_typeof("exposed_revision_ids") = 'array'
             AND jsonb_array_length("exposed_revision_ids") > 0
            THEN 'exposed'
        ELSE 'legacy_empty'
    END,
    "exposed_at" = CASE
        WHEN jsonb_typeof("exposed_revision_ids") = 'array'
             AND jsonb_array_length("exposed_revision_ids") > 0
            THEN "created_at"
        ELSE NULL
    END;

CREATE INDEX "external_memory_uses_subject_id_status_created_at_idx"
ON "external_memory_uses"("subject_id", "status", "created_at");

CREATE TABLE "personal_memory_feedback_receipts" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "request_id" TEXT NOT NULL,
    "subject_id" TEXT NOT NULL,
    "revision_id" UUID NOT NULL,
    "event_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "outcome_id" UUID,
    "last_error_code" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "completed_at" TIMESTAMP(3),

    CONSTRAINT "personal_memory_feedback_receipts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "personal_memory_feedback_receipts_provider_project_id_request_id_revision_id_key"
ON "personal_memory_feedback_receipts"("provider", "project_id", "request_id", "revision_id");

CREATE INDEX "personal_memory_feedback_receipts_subject_id_status_created_at_idx"
ON "personal_memory_feedback_receipts"("subject_id", "status", "created_at");

CREATE INDEX "personal_memory_feedback_receipts_project_id_request_id_idx"
ON "personal_memory_feedback_receipts"("project_id", "request_id");

ALTER TABLE "personal_memory_feedback_receipts"
ADD CONSTRAINT "personal_memory_feedback_receipts_project_id_fkey"
FOREIGN KEY ("project_id") REFERENCES "projects"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
