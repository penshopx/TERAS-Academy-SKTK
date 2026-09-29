-- Only tables are needed at runtime, including on Publish where custom SQL
-- functions/triggers are not carried by the schema diff. The application
-- performs transactional writes and a one-time bounded backfill.
BEGIN;
CREATE TABLE IF NOT EXISTS teras_agent_health_days (
  day date PRIMARY KEY,
  run_count integer NOT NULL DEFAULT 0,
  completed_count integer NOT NULL DEFAULT 0,
  partial_count integer NOT NULL DEFAULT 0,
  failed_count integer NOT NULL DEFAULT 0,
  fallback_count integer NOT NULL DEFAULT 0,
  CONSTRAINT teras_agent_health_days_nonnegative CHECK (
    run_count >= 0 AND completed_count >= 0 AND partial_count >= 0
    AND failed_count >= 0 AND fallback_count >= 0
  )
);
CREATE TABLE IF NOT EXISTS teras_agent_health_state (
  id text PRIMARY KEY CONSTRAINT teras_agent_health_state_singleton CHECK (id = 'global'),
  backfilled_at timestamptz
);

DROP TRIGGER IF EXISTS teras_project_agent_health_run_trigger ON teras_agent_runs;
DROP FUNCTION IF EXISTS teras_project_agent_health_run();
DROP FUNCTION IF EXISTS teras_reconcile_agent_health_day(date);
COMMIT;