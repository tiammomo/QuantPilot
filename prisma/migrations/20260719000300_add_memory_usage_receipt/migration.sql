ALTER TABLE "external_memory_uses"
ADD COLUMN "provider_usage_id" UUID;

CREATE INDEX "external_memory_uses_provider_usage_id_idx"
ON "external_memory_uses"("provider_usage_id");
