DO $$
BEGIN
  IF to_regclass('teras_diagnostic_follow_up_reminder_deliveries') IS NULL THEN
    RETURN;
  END IF;

  ALTER TABLE "teras_diagnostic_follow_up_reminder_deliveries"
    DROP CONSTRAINT IF EXISTS "teras_diagnostic_follow_up_reminder_delivery_status_check";
  ALTER TABLE "teras_diagnostic_follow_up_reminder_deliveries"
    ADD CONSTRAINT "teras_diagnostic_follow_up_reminder_delivery_status_check"
    CHECK ("status" IN ('pending','sending','sent','failed','permanently_failed'));

  UPDATE "teras_diagnostic_follow_up_reminder_deliveries"
  SET "status" = 'permanently_failed',
      "updated_at" = now()
  WHERE "status" = 'failed'
    AND "attempt_count" = 3;
END
$$;