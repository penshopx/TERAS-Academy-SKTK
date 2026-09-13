CREATE TABLE IF NOT EXISTS "teras_readiness_audit_export_aggregates" (
  "day" date NOT NULL,
  "record_group" text NOT NULL,
  "outcome" text NOT NULL,
  "count" integer NOT NULL,
  CONSTRAINT "teras_readiness_audit_export_aggregates_pkey" PRIMARY KEY ("day", "record_group", "outcome"),
  CONSTRAINT "teras_readiness_audit_export_aggregates_group_check"
    CHECK ("record_group" IN ('1.000–4.999 record', '5.000–9.999 record', '10.000+ record')),
  CONSTRAINT "teras_readiness_audit_export_aggregates_outcome_check"
    CHECK ("outcome" IN ('succeeded', 'cancelled', 'failed')),
  CONSTRAINT "teras_readiness_audit_export_aggregates_count_check" CHECK ("count" > 0)
);