ALTER TABLE "teras_readiness_audit_export_retention_health"
  ADD COLUMN IF NOT EXISTS "monitoring_started_at" timestamp with time zone DEFAULT now() NOT NULL;

COMMENT ON COLUMN "teras_readiness_audit_export_retention_health"."monitoring_started_at" IS
  'First persisted monitoring baseline, independent of any retention cleanup attempt.';