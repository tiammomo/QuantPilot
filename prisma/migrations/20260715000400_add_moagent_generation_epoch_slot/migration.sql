-- Enforce one non-terminal Mission generation per project across web workers.
-- PostgreSQL unique indexes allow multiple NULL values, so terminal Missions
-- release the active slot by setting active_slot = NULL.

BEGIN;

ALTER TABLE "agent_missions"
    ADD COLUMN "active_slot" INTEGER;

UPDATE "agent_missions"
SET "active_slot" = 1
WHERE "status" NOT IN ('completed', 'failed', 'cancelled');

ALTER TABLE "agent_missions"
    ALTER COLUMN "active_slot" SET DEFAULT 1;

CREATE UNIQUE INDEX "agent_missions_project_id_active_slot_key"
    ON "agent_missions"("project_id", "active_slot");

COMMIT;
