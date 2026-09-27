CREATE INDEX CONCURRENTLY IF NOT EXISTS teras_agent_runs_observability_cursor_idx
  ON teras_agent_runs(created_at DESC, id DESC);