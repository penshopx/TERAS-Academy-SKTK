CREATE INDEX IF NOT EXISTS "teras_diagnostic_follow_up_reminder_resolution_resolved_at_idx"
  ON "teras_diagnostic_follow_up_reminder_resolutions" ("resolved_at", "reminder_delivery_id");