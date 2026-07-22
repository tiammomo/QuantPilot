ALTER TABLE "messages"
DROP COLUMN IF EXISTS "session_id";

DROP TABLE IF EXISTS "sessions";
