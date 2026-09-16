CREATE TABLE IF NOT EXISTS "teras_readiness_audit_export_attempts" (
  "attempt_key" text PRIMARY KEY NOT NULL,
  "day" date NOT NULL
);

CREATE INDEX IF NOT EXISTS "teras_readiness_audit_export_attempts_day_idx"
  ON "teras_readiness_audit_export_attempts" ("day");

COMMENT ON TABLE "teras_readiness_audit_export_attempts" IS
  'Anonymous idempotency keys for readiness export outcome delivery; contains no actor, audit filter, or export content.';