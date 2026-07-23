ALTER TABLE "projects"
ADD COLUMN "agent_profile_version" TEXT NOT NULL DEFAULT '1.0.0',
ADD COLUMN "data_agent_composition_sha256" TEXT NOT NULL
  DEFAULT 'sha256:89436aed794ee3f03ae211a3d07ea6bc0c7fd94cd46663dba9f31917fcb8d575';

CREATE INDEX "projects_data_agent_composition_sha256_idx"
ON "projects" ("data_agent_composition_sha256");
