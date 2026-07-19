CREATE TABLE "personal_memory_controls" (
    "id" TEXT NOT NULL,
    "subject_id" TEXT NOT NULL,
    "personalization_enabled" BOOLEAN NOT NULL DEFAULT false,
    "policy_version" TEXT NOT NULL,
    "enabled_at" TIMESTAMP(3),
    "disabled_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "personal_memory_controls_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "personal_memory_controls_subject_id_key"
ON "personal_memory_controls"("subject_id");

CREATE INDEX "personal_memory_controls_personalization_enabled_updated_at_idx"
ON "personal_memory_controls"("personalization_enabled", "updated_at");
