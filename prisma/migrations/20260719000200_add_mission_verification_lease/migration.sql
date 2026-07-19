ALTER TABLE "agent_missions"
  ADD COLUMN "verification_lease_owner" TEXT,
  ADD COLUMN "verification_lease_expires_at" TIMESTAMP(3),
  ADD COLUMN "verification_last_heartbeat_at" TIMESTAMP(3),
  ADD COLUMN "verification_fencing_token" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "agent_missions"
  ADD CONSTRAINT "agent_missions_verification_lease_pair_check"
  CHECK (
    ("verification_lease_owner" IS NULL AND "verification_lease_expires_at" IS NULL)
    OR
    ("verification_lease_owner" IS NOT NULL AND "verification_lease_expires_at" IS NOT NULL)
  ),
  ADD CONSTRAINT "agent_missions_verification_fencing_token_check"
  CHECK ("verification_fencing_token" >= 0);

CREATE INDEX "agent_missions_status_verification_lease_expires_at_idx"
  ON "agent_missions"("status", "verification_lease_expires_at");
