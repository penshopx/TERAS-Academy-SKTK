CREATE INDEX IF NOT EXISTS "teras_diagnostic_follow_up_reminder_resolution_resolved_at_idx"
  ON "teras_diagnostic_follow_up_reminder_resolutions" ("resolved_at", "reminder_delivery_id");

ALTER TABLE "teras_diagnostic_follow_up_reminder_deliveries"
  ADD COLUMN IF NOT EXISTS "escalation_resolved_at" timestamp with time zone;

UPDATE "teras_diagnostic_follow_up_reminder_deliveries" delivery
SET "escalation_resolved_at" = resolution."resolved_at"
FROM "teras_diagnostic_follow_up_reminder_resolutions" resolution
WHERE resolution."reminder_delivery_id" = delivery."id"
  AND delivery."escalation_resolved_at" IS DISTINCT FROM resolution."resolved_at";

DROP INDEX IF EXISTS "teras_diagnostic_follow_up_reminder_failed_history_idx";
CREATE INDEX "teras_diagnostic_follow_up_reminder_failed_history_idx"
  ON "teras_diagnostic_follow_up_reminder_deliveries" ("last_attempt_at" DESC NULLS FIRST, "id" DESC NULLS FIRST)
  WHERE "status" = 'permanently_failed' AND "escalation_resolved_at" IS NULL;

CREATE INDEX IF NOT EXISTS "teras_diagnostic_follow_up_reminder_resolved_history_idx"
  ON "teras_diagnostic_follow_up_reminder_deliveries" ("escalation_resolved_at" DESC NULLS FIRST, "id" DESC NULLS FIRST)
  WHERE "status" = 'permanently_failed' AND "escalation_resolved_at" IS NOT NULL;