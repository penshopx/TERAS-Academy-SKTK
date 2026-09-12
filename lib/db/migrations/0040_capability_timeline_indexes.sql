BEGIN;

CREATE INDEX IF NOT EXISTS teras_enrollment_pathway_events_timeline_idx ON teras_enrollment_pathway_events (enrollment_id, created_at, id);
CREATE INDEX IF NOT EXISTS teras_practice_attempts_timeline_idx ON teras_practice_attempts (learner_id, pathway_id, created_at, id);
CREATE INDEX IF NOT EXISTS teras_evidence_timeline_idx ON teras_evidence (learner_id, pathway_id, created_at, id);
CREATE INDEX IF NOT EXISTS teras_evidence_reviews_parent_timeline_idx ON teras_evidence_reviews (evidence_id, created_at, id);
CREATE INDEX IF NOT EXISTS teras_assessment_attempts_timeline_idx ON teras_assessment_attempts (learner_id, pathway_id, created_at, id);
CREATE INDEX IF NOT EXISTS teras_gaps_learner_pathway_idx ON teras_gaps (learner_id, pathway_id, id);
CREATE INDEX IF NOT EXISTS teras_remediation_plans_gap_idx ON teras_remediation_plans (gap_id, id);
CREATE INDEX IF NOT EXISTS teras_remediation_activities_plan_idx ON teras_remediation_activities (plan_id, id);
CREATE INDEX IF NOT EXISTS teras_remediation_events_parent_timeline_idx ON teras_remediation_events (activity_id, created_at, id);
CREATE INDEX IF NOT EXISTS teras_learning_record_links_timeline_idx ON teras_learning_record_links (learner_id, pathway_id, created_at, id);
CREATE INDEX IF NOT EXISTS teras_reassessment_links_timeline_idx ON teras_reassessment_links (learner_id, pathway_id, created_at, id);
CREATE INDEX IF NOT EXISTS teras_learning_transition_timeline_idx ON teras_learning_transition_events (learner_id, enrollment_id, pathway_id, created_at, id);
CREATE INDEX IF NOT EXISTS teras_diagnostic_gaps_profile_idx ON teras_diagnostic_gaps (profile_id, id);
CREATE INDEX IF NOT EXISTS teras_diagnostic_recommendations_profile_idx ON teras_diagnostic_recommendations (profile_id, id);

COMMIT;