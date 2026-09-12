CREATE TABLE IF NOT EXISTS "teras_diagnostic_follow_up_failure_notifications" (
  "id" text PRIMARY KEY NOT NULL,
  "reminder_delivery_id" text NOT NULL REFERENCES "teras_diagnostic_follow_up_reminder_deliveries"("id") ON DELETE CASCADE,
  "destination" text NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "attempted_at" timestamp with time zone,
  "sent_at" timestamp with time zone,
  "failure_reason" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_by" text DEFAULT 'system' NOT NULL,
  CONSTRAINT "teras_diagnostic_follow_up_failure_notification_status_check"
    CHECK ("status" IN ('pending','sending','sent','failed'))
);

CREATE UNIQUE INDEX IF NOT EXISTS "teras_diagnostic_follow_up_failure_notification_delivery_unique"
  ON "teras_diagnostic_follow_up_failure_notifications" ("reminder_delivery_id");