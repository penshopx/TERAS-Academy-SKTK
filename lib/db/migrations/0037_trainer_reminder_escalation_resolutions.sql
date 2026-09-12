CREATE TABLE IF NOT EXISTS "teras_diagnostic_follow_up_reminder_resolutions" (
  "id" text PRIMARY KEY NOT NULL,
  "reminder_delivery_id" text NOT NULL REFERENCES "teras_diagnostic_follow_up_reminder_deliveries"("id") ON DELETE CASCADE,
  "note" text NOT NULL,
  "resolved_by_person_id" text NOT NULL REFERENCES "teras_people"("id"),
  "resolved_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_by" text DEFAULT 'system' NOT NULL,
  CONSTRAINT "teras_diagnostic_follow_up_reminder_resolution_note_check"
    CHECK (length(trim("note")) > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS "teras_diagnostic_follow_up_reminder_resolution_delivery_unique"
  ON "teras_diagnostic_follow_up_reminder_resolutions" ("reminder_delivery_id");