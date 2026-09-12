ALTER TABLE "teras_practice_reviews"
  ADD COLUMN IF NOT EXISTS "idempotency_key" text,
  ADD COLUMN IF NOT EXISTS "idempotency_fingerprint" text;

CREATE UNIQUE INDEX IF NOT EXISTS "teras_practice_reviews_idempotency_unique"
  ON "teras_practice_reviews" ("attempt_id", "reviewer_id", "idempotency_key");

ALTER TABLE "teras_evidence_reviews"
  ADD COLUMN IF NOT EXISTS "idempotency_key" text,
  ADD COLUMN IF NOT EXISTS "idempotency_fingerprint" text;

CREATE UNIQUE INDEX IF NOT EXISTS "teras_evidence_reviews_idempotency_unique"
  ON "teras_evidence_reviews" ("evidence_id", "reviewer_id", "idempotency_key");