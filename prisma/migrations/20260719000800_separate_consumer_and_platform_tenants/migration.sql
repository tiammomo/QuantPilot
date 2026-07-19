ALTER TABLE "governed_knowledge_uses"
RENAME COLUMN "tenant_id" TO "consumer_id";

UPDATE "governed_knowledge_uses"
SET "consumer_id" = 'legacy-consumer'
WHERE "consumer_id" = 'legacy-unscoped';

DROP INDEX "governed_knowledge_uses_tenant_id_project_id_created_at_idx";

CREATE INDEX "governed_knowledge_uses_consumer_id_project_id_created_at_idx"
ON "governed_knowledge_uses"("consumer_id", "project_id", "created_at");
