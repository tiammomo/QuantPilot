-- Bind every physical AgentRun to the exact MoAgent application build. Existing
-- rows predate build provenance and remain explicitly distinguishable instead
-- of being mislabeled as the build applying this migration.
ALTER TABLE "agent_runs" ADD COLUMN "build_revision" TEXT;

UPDATE "agent_runs"
SET "build_revision" = 'legacy:pre-1.7'
WHERE "build_revision" IS NULL;

ALTER TABLE "agent_runs" ALTER COLUMN "build_revision" SET NOT NULL;
