ALTER TABLE "teras_diagnostic_follow_up_failure_notifications"
  ADD COLUMN IF NOT EXISTS "channel" text;

UPDATE "teras_diagnostic_follow_up_failure_notifications"
SET "channel" = 'email'
WHERE "channel" IS NULL;

ALTER TABLE "teras_diagnostic_follow_up_failure_notifications"
  ALTER COLUMN "channel" SET DEFAULT 'email',
  ALTER COLUMN "channel" SET NOT NULL;

DROP INDEX IF EXISTS "teras_diagnostic_follow_up_failure_notification_delivery_unique";

CREATE UNIQUE INDEX IF NOT EXISTS "teras_follow_up_failure_notification_delivery_channel_unique"
  ON "teras_diagnostic_follow_up_failure_notifications" ("reminder_delivery_id", "channel");

ALTER TABLE "teras_diagnostic_follow_up_failure_notifications"
  DROP CONSTRAINT IF EXISTS "teras_diagnostic_follow_up_failure_notification_channel_check";

ALTER TABLE "teras_diagnostic_follow_up_failure_notifications"
  ADD CONSTRAINT "teras_diagnostic_follow_up_failure_notification_channel_check"
  CHECK ("channel" IN ('email','webhook'));