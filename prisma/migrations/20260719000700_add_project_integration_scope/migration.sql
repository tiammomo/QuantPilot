ALTER TABLE "external_memory_uses"
ADD COLUMN "integration_scope_sha256" TEXT;

UPDATE "external_memory_uses"
SET "integration_scope_sha256" = 'sha256:0000000000000000000000000000000000000000000000000000000000000000';

ALTER TABLE "external_memory_uses"
ALTER COLUMN "integration_scope_sha256" SET NOT NULL;

ALTER TABLE "governed_knowledge_uses"
ADD COLUMN "tenant_id" TEXT,
ADD COLUMN "integration_scope_sha256" TEXT,
ADD COLUMN "requested_space_ids" JSONB,
ADD COLUMN "project_space_id" TEXT;

UPDATE "governed_knowledge_uses"
SET
  "tenant_id" = 'legacy-unscoped',
  "integration_scope_sha256" = 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
  "requested_space_ids" = '[]'::jsonb;

ALTER TABLE "governed_knowledge_uses"
ALTER COLUMN "tenant_id" SET NOT NULL,
ALTER COLUMN "integration_scope_sha256" SET NOT NULL,
ALTER COLUMN "requested_space_ids" SET NOT NULL;

CREATE INDEX "external_memory_uses_tenant_id_project_id_created_at_idx"
ON "external_memory_uses"("tenant_id", "project_id", "created_at");

CREATE INDEX "governed_knowledge_uses_tenant_id_project_id_created_at_idx"
ON "governed_knowledge_uses"("tenant_id", "project_id", "created_at");
