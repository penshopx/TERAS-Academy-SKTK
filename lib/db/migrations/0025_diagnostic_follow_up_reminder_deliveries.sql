CREATE TABLE IF NOT EXISTS "teras_diagnostic_follow_up_reminder_deliveries" (
  "id" text PRIMARY KEY NOT NULL,
  "follow_up_id" text NOT NULL REFERENCES "teras_diagnostic_recommendation_follow_ups"("id") ON DELETE CASCADE,
  "trainer_id" text NOT NULL REFERENCES "teras_people"("id"),
  "channel" text NOT NULL,
  "reminder_kind" text NOT NULL,
  "destination" text NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "attempt_count" integer DEFAULT 0 NOT NULL,
  "last_attempt_at" timestamptz,
  "sent_at" timestamptz,
  "failure_reason" text,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  "created_by" text DEFAULT 'system' NOT NULL,
  CONSTRAINT "teras_diagnostic_follow_up_reminder_delivery_channel_check" CHECK ("channel" IN ('email')),
  CONSTRAINT "teras_diagnostic_follow_up_reminder_delivery_kind_check" CHECK ("reminder_kind" IN ('due_soon','overdue')),
  CONSTRAINT "teras_diagnostic_follow_up_reminder_delivery_status_check" CHECK ("status" IN ('pending','sending','sent','failed')),
  CONSTRAINT "teras_diagnostic_follow_up_reminder_delivery_attempt_count_check" CHECK ("attempt_count" >= 0 AND "attempt_count" <= 3)
);
CREATE UNIQUE INDEX IF NOT EXISTS "teras_diagnostic_follow_up_reminder_delivery_unique"
  ON "teras_diagnostic_follow_up_reminder_deliveries" ("follow_up_id","reminder_kind","channel");
CREATE INDEX IF NOT EXISTS "teras_diagnostic_follow_up_reminder_delivery_status_idx"
  ON "teras_diagnostic_follow_up_reminder_deliveries" ("status","last_attempt_at");