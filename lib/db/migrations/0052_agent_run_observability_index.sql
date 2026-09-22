CREATE INDEX IF NOT EXISTS teras_agent_runs_observability_idx
  ON teras_agent_runs(created_at DESC, agent_version, provider, model);