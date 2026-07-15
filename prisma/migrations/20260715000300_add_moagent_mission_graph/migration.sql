-- Additive MoAgent Mission Graph and immutable evidence receipts. Agent runs
-- may now end at candidate_complete; product completion belongs to a mission
-- accepted against current validation, artifact and preview evidence.

BEGIN;

CREATE TABLE "agent_missions" (
    "id" TEXT NOT NULL,
    "generation_id" UUID NOT NULL,
    "project_id" TEXT NOT NULL,
    "request_id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'running',
    "version" INTEGER NOT NULL DEFAULT 0,
    "candidate_version" INTEGER NOT NULL DEFAULT 0,
    "current_candidate_run_id" TEXT,
    "current_candidate_request_id" TEXT,
    "accepted_receipt_id" TEXT,
    "spec" JSONB NOT NULL,
    "spec_hash" TEXT NOT NULL,
    "error_code" TEXT,
    "error_message" TEXT,
    "candidate_submitted_at" TIMESTAMP(3),
    "verification_started_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_missions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "agent_mission_nodes" (
    "id" TEXT NOT NULL,
    "mission_id" TEXT NOT NULL,
    "node_key" TEXT NOT NULL,
    "node_type" TEXT NOT NULL,
    "effect" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "version" INTEGER NOT NULL DEFAULT 0,
    "dependencies" JSONB NOT NULL,
    "allowed_tools" JSONB NOT NULL,
    "required_skill_sections" JSONB NOT NULL,
    "input_artifacts" JSONB NOT NULL,
    "output_artifacts" JSONB NOT NULL,
    "budget" JSONB NOT NULL,
    "acceptance_predicates" JSONB NOT NULL,
    "started_at" TIMESTAMP(3),
    "finished_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_mission_nodes_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "agent_evidence_receipts" (
    "id" TEXT NOT NULL,
    "mission_id" TEXT NOT NULL,
    "candidate_version" INTEGER NOT NULL,
    "receipt_type" TEXT NOT NULL,
    "verdict" TEXT NOT NULL,
    "subject_hash" TEXT NOT NULL,
    "receipt_hash" TEXT NOT NULL,
    "source_run_id" TEXT,
    "source_request_id" TEXT,
    "payload" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_evidence_receipts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "agent_missions_generation_id_key" ON "agent_missions"("generation_id");
CREATE UNIQUE INDEX "agent_missions_request_id_key" ON "agent_missions"("request_id");
CREATE UNIQUE INDEX "agent_missions_accepted_receipt_id_key" ON "agent_missions"("accepted_receipt_id");
CREATE UNIQUE INDEX "agent_missions_request_id_project_id_key" ON "agent_missions"("request_id", "project_id");
CREATE INDEX "agent_missions_project_id_status_updated_at_idx" ON "agent_missions"("project_id", "status", "updated_at");
CREATE INDEX "agent_missions_status_updated_at_idx" ON "agent_missions"("status", "updated_at");

CREATE UNIQUE INDEX "agent_mission_nodes_mission_id_node_key_key" ON "agent_mission_nodes"("mission_id", "node_key");
CREATE INDEX "agent_mission_nodes_mission_id_status_idx" ON "agent_mission_nodes"("mission_id", "status");

CREATE UNIQUE INDEX "agent_evidence_receipts_receipt_hash_key" ON "agent_evidence_receipts"("receipt_hash");
CREATE UNIQUE INDEX "agent_evidence_receipts_mission_id_candidate_version_receipt_type_subject_hash_key"
    ON "agent_evidence_receipts"("mission_id", "candidate_version", "receipt_type", "subject_hash");
CREATE INDEX "agent_evidence_receipts_mission_id_candidate_version_created_at_idx"
    ON "agent_evidence_receipts"("mission_id", "candidate_version", "created_at");
CREATE INDEX "agent_evidence_receipts_verdict_created_at_idx" ON "agent_evidence_receipts"("verdict", "created_at");

ALTER TABLE "agent_missions"
    ADD CONSTRAINT "agent_missions_project_id_fkey"
    FOREIGN KEY ("project_id") REFERENCES "projects"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "agent_missions"
    ADD CONSTRAINT "agent_missions_request_id_project_id_fkey"
    FOREIGN KEY ("request_id", "project_id") REFERENCES "user_requests"("id", "project_id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "agent_mission_nodes"
    ADD CONSTRAINT "agent_mission_nodes_mission_id_fkey"
    FOREIGN KEY ("mission_id") REFERENCES "agent_missions"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "agent_evidence_receipts"
    ADD CONSTRAINT "agent_evidence_receipts_mission_id_fkey"
    FOREIGN KEY ("mission_id") REFERENCES "agent_missions"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "agent_missions"
    ADD CONSTRAINT "agent_missions_accepted_receipt_id_fkey"
    FOREIGN KEY ("accepted_receipt_id") REFERENCES "agent_evidence_receipts"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

COMMIT;
