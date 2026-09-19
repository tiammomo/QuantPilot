ALTER TABLE "eval_queue_items"
  ADD COLUMN "lease_token" TEXT,
  ADD COLUMN "lease_expires_at" TIMESTAMP(3),
  ADD COLUMN "attempt_count" INTEGER NOT NULL DEFAULT 0;

CREATE INDEX "eval_queue_items_status_lease_expires_at_idx"
  ON "eval_queue_items"("status", "lease_expires_at");
