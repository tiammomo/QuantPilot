ALTER TABLE "agent_runs"
ALTER COLUMN "workspace_key" DROP DEFAULT;

ALTER TABLE "agent_runs"
ADD CONSTRAINT "agent_runs_workspace_key_sha256_check"
CHECK ("workspace_key" ~ '^sha256:[0-9a-f]{64}$');
