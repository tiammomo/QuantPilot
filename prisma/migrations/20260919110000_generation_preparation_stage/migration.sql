-- Expand the durable job lifecycle to include Worker-owned preparation.
-- Existing rows remain valid; no business data is rewritten.
ALTER TABLE "agent_generation_jobs"
  DROP CONSTRAINT "agent_generation_jobs_stage_check",
  ADD CONSTRAINT "agent_generation_jobs_stage_check" CHECK (
    "stage" IN ('planning_data_prefetch', 'agent_execution', 'automatic_validation', 'completed')
  );
