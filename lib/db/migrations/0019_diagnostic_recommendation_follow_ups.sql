CREATE TABLE IF NOT EXISTS "teras_diagnostic_recommendation_follow_ups" (
  "id" text PRIMARY KEY NOT NULL,
  "recommendation_id" text NOT NULL REFERENCES "teras_diagnostic_recommendations"("id") ON DELETE CASCADE,
  "trainer_id" text NOT NULL REFERENCES "teras_people"("id"),
  "status" text NOT NULL,
  "target_at" timestamptz,
  "note" text NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  "created_by" text DEFAULT 'system' NOT NULL,
  CONSTRAINT "teras_diagnostic_recommendation_follow_ups_status_check" CHECK ("status" IN ('planned','in_progress','completed'))
);
CREATE INDEX IF NOT EXISTS "teras_diagnostic_recommendation_follow_ups_recommendation_created_idx"
  ON "teras_diagnostic_recommendation_follow_ups" ("recommendation_id","created_at");