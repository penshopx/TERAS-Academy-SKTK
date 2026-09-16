-- Retention policy: keep the current UTC day plus 90 complete UTC days.
-- The API cleanup runs daily and deletes only rows strictly older than its
-- cutoff, preserving the cutoff day and the active seven-day reporting window.
COMMENT ON TABLE "teras_readiness_audit_export_aggregates" IS
  'Anonymous readiness export outcome aggregates; API retention cleanup keeps the current UTC day plus 90 complete UTC days.';