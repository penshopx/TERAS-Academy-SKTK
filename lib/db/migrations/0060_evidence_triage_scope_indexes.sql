-- Build before schema push for existing installations; keep the Drizzle definitions
-- in sync for clean databases. Each statement is safe to replay outside a transaction.
CREATE INDEX CONCURRENTLY IF NOT EXISTS teras_enrollments_trainer_active_idx
  ON teras_enrollments (trainer_id, id) WHERE status = 'active';
CREATE INDEX CONCURRENTLY IF NOT EXISTS teras_evidence_triage_scope_idx
  ON teras_evidence (learner_id, pathway_id, module_id, id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS teras_evidence_requirements_module_idx
  ON teras_evidence_requirements (module_id);