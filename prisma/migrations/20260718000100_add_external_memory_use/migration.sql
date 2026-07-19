CREATE TABLE "external_memory_uses" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "request_id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "subject_id" TEXT NOT NULL,
    "trace_id" UUID NOT NULL,
    "policy_id" UUID NOT NULL,
    "policy_version" INTEGER NOT NULL,
    "valid_at" TIMESTAMP(3) NOT NULL,
    "known_at" TIMESTAMP(3) NOT NULL,
    "source_projection_sha256" TEXT NOT NULL,
    "delivered_context_sha256" TEXT NOT NULL,
    "exposed_revision_ids" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "external_memory_uses_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "external_memory_uses_provider_project_id_request_id_key"
ON "external_memory_uses"("provider", "project_id", "request_id");

CREATE INDEX "external_memory_uses_project_id_created_at_idx"
ON "external_memory_uses"("project_id", "created_at");

CREATE INDEX "external_memory_uses_subject_id_created_at_idx"
ON "external_memory_uses"("subject_id", "created_at");

CREATE INDEX "external_memory_uses_trace_id_idx"
ON "external_memory_uses"("trace_id");

ALTER TABLE "external_memory_uses"
ADD CONSTRAINT "external_memory_uses_project_id_fkey"
FOREIGN KEY ("project_id") REFERENCES "projects"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
