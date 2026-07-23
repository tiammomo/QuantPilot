ALTER TABLE "projects"
ADD COLUMN "agent_profile_id" TEXT NOT NULL DEFAULT 'quantpilot.finance-research';

CREATE INDEX "projects_agent_profile_id_idx"
ON "projects" ("agent_profile_id");
