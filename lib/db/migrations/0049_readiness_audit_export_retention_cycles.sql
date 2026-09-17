CREATE TABLE IF NOT EXISTS "teras_readiness_audit_export_retention_cycles" (
  "day" date PRIMARY KEY NOT NULL,
  "claimed_at" timestamp with time zone DEFAULT now() NOT NULL
);

COMMENT ON TABLE "teras_readiness_audit_export_retention_cycles" IS
  'Durable UTC-day claims ensuring readiness export trend retention cleanup runs once across API instances.';