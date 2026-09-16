BEGIN;

CREATE INDEX IF NOT EXISTS teras_practice_reviews_latest_idx
  ON teras_practice_reviews (attempt_id, created_at DESC, id DESC);

COMMIT;