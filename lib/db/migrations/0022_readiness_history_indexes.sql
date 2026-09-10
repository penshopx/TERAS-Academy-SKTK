CREATE INDEX IF NOT EXISTS teras_enrollments_learner_id_idx
  ON teras_enrollments (learner_id, id);

CREATE INDEX IF NOT EXISTS teras_readiness_events_evaluated_at_idx
  ON teras_readiness_events (evaluated_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS teras_readiness_events_enrollment_evaluated_idx
  ON teras_readiness_events (enrollment_id, evaluated_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS teras_readiness_events_pathway_evaluated_idx
  ON teras_readiness_events (pathway_id, evaluated_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS teras_readiness_events_status_evaluated_idx
  ON teras_readiness_events (status, evaluated_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS teras_readiness_events_rule_version_evaluated_idx
  ON teras_readiness_events (rule_version, evaluated_at DESC, id DESC);