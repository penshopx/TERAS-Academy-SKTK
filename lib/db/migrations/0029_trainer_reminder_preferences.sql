CREATE TABLE IF NOT EXISTS "teras_trainer_reminder_preferences" (
  "id" text PRIMARY KEY NOT NULL,
  "trainer_id" text NOT NULL REFERENCES "teras_people"("id") ON DELETE CASCADE,
  "email_enabled" boolean DEFAULT true NOT NULL,
  "time_zone" text DEFAULT 'Asia/Jakarta' NOT NULL,
  "quiet_hours_start" text,
  "quiet_hours_end" text,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  "created_by" text DEFAULT 'system' NOT NULL,
  CONSTRAINT "teras_trainer_reminder_preferences_quiet_hours_check" CHECK (
    ("quiet_hours_start" IS NULL AND "quiet_hours_end" IS NULL)
    OR ("quiet_hours_start" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
      AND "quiet_hours_end" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$')
  )
);

CREATE INDEX IF NOT EXISTS "teras_trainer_reminder_preferences_trainer_created_idx"
  ON "teras_trainer_reminder_preferences" ("trainer_id", "created_at");