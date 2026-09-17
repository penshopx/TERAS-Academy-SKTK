CREATE TABLE IF NOT EXISTS "teras_readiness_audit_export_retention_health" (
  "id" text PRIMARY KEY NOT NULL,
  "consecutive_failures" integer DEFAULT 0 NOT NULL,
  "last_failure_cycle" date,
  "last_failure_at" timestamp with time zone,
  "last_success_at" timestamp with time zone,
  CONSTRAINT "teras_readiness_audit_export_retention_health_singleton_check"
    CHECK ("id" = 'global'),
  CONSTRAINT "teras_readiness_audit_export_retention_health_failures_check"
    CHECK ("consecutive_failures" >= 0)
);

COMMENT ON TABLE "teras_readiness_audit_export_retention_health" IS
  'Shared anonymous health state for readiness export trend retention cleanup across API instances.';