ALTER TABLE "teras_diagnostic_recommendation_follow_ups"
  ADD COLUMN IF NOT EXISTS "idempotency_key" text,
  ADD COLUMN IF NOT EXISTS "idempotency_fingerprint" text;

CREATE UNIQUE INDEX IF NOT EXISTS "teras_diagnostic_recommendation_follow_ups_idempotency_unique"
  ON "teras_diagnostic_recommendation_follow_ups" ("recommendation_id", "trainer_id", "idempotency_key");