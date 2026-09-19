CREATE TABLE IF NOT EXISTS teras_agent_runs (
  id text PRIMARY KEY,
  agent_id text NOT NULL,
  agent_version text NOT NULL,
  actor_person_id text REFERENCES teras_people(id),
  objective text NOT NULL,
  policy_decision text NOT NULL,
  tool_refs text[] NOT NULL DEFAULT '{}',
  evidence_refs text[] NOT NULL DEFAULT '{}',
  provider text,
  model text,
  status text NOT NULL,
  result_summary jsonb,
  result_hash text,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  CONSTRAINT teras_agent_runs_policy_check CHECK (policy_decision IN ('ALLOW_READ','ALLOW_PROPOSE','REQUIRES_APPROVAL','DENY')),
  CONSTRAINT teras_agent_runs_status_check CHECK (status IN ('PLANNED','RUNNING','COMPLETED','FAILED','PARTIAL'))
);
CREATE INDEX IF NOT EXISTS teras_agent_runs_actor_created_idx ON teras_agent_runs(actor_person_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS teras_agent_runs_agent_created_idx ON teras_agent_runs(agent_id, created_at DESC, id DESC);
CREATE OR REPLACE FUNCTION teras_agent_runs_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'teras_agent_runs is append-only'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS teras_agent_runs_append_only_trigger ON teras_agent_runs;
CREATE TRIGGER teras_agent_runs_append_only_trigger
  BEFORE UPDATE OR DELETE ON teras_agent_runs
  FOR EACH ROW EXECUTE FUNCTION teras_agent_runs_append_only();