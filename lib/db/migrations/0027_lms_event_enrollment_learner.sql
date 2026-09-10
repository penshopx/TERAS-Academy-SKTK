BEGIN;

-- Ownership inventory:
-- These append-only LMS records redundantly retain enrollment_id and learner_id,
-- so their learner must remain tied to the enrollment aggregate.
-- Catalogue-linked IDs and causal junction tables are intentionally excluded:
-- those referenced records are shared catalogue data or are not one owned parent.
LOCK TABLE
  teras_enrollments,
  teras_activity_completion_events,
  teras_outcome_verification_events,
  teras_readiness_transfer_events,
  teras_learning_transition_events
  IN SHARE ROW EXCLUSIVE MODE;

DO $$
DECLARE
  mismatch_table text;
BEGIN
  SELECT source_table
  INTO mismatch_table
  FROM (
    SELECT 'teras_activity_completion_events' AS source_table
    FROM teras_activity_completion_events AS event
    JOIN teras_enrollments AS enrollment ON enrollment.id = event.enrollment_id
    WHERE event.learner_id <> enrollment.learner_id
    UNION ALL
    SELECT 'teras_outcome_verification_events'
    FROM teras_outcome_verification_events AS event
    JOIN teras_enrollments AS enrollment ON enrollment.id = event.enrollment_id
    WHERE event.learner_id <> enrollment.learner_id
    UNION ALL
    SELECT 'teras_readiness_transfer_events'
    FROM teras_readiness_transfer_events AS event
    JOIN teras_enrollments AS enrollment ON enrollment.id = event.enrollment_id
    WHERE event.learner_id <> enrollment.learner_id
    UNION ALL
    SELECT 'teras_learning_transition_events'
    FROM teras_learning_transition_events AS event
    JOIN teras_enrollments AS enrollment ON enrollment.id = event.enrollment_id
    WHERE event.learner_id <> enrollment.learner_id
  ) AS mismatches
  LIMIT 1;

  IF mismatch_table IS NOT NULL THEN
    RAISE EXCEPTION
      'Cannot enforce LMS event ownership: learner differs from enrollment owner in %',
      mismatch_table;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'teras_enrollments_id_learner_unique'
      AND conrelid = 'teras_enrollments'::regclass
  ) THEN
    ALTER TABLE teras_enrollments
      ADD CONSTRAINT teras_enrollments_id_learner_unique
      UNIQUE (id, learner_id);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'teras_activity_completion_enrollment_learner_fk'
      AND conrelid = 'teras_activity_completion_events'::regclass
  ) THEN
    ALTER TABLE teras_activity_completion_events
      ADD CONSTRAINT teras_activity_completion_enrollment_learner_fk
      FOREIGN KEY (enrollment_id, learner_id)
      REFERENCES teras_enrollments (id, learner_id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'teras_outcome_verification_enrollment_learner_fk'
      AND conrelid = 'teras_outcome_verification_events'::regclass
  ) THEN
    ALTER TABLE teras_outcome_verification_events
      ADD CONSTRAINT teras_outcome_verification_enrollment_learner_fk
      FOREIGN KEY (enrollment_id, learner_id)
      REFERENCES teras_enrollments (id, learner_id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'teras_readiness_transfer_enrollment_learner_fk'
      AND conrelid = 'teras_readiness_transfer_events'::regclass
  ) THEN
    ALTER TABLE teras_readiness_transfer_events
      ADD CONSTRAINT teras_readiness_transfer_enrollment_learner_fk
      FOREIGN KEY (enrollment_id, learner_id)
      REFERENCES teras_enrollments (id, learner_id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'teras_learning_transition_enrollment_learner_fk'
      AND conrelid = 'teras_learning_transition_events'::regclass
  ) THEN
    ALTER TABLE teras_learning_transition_events
      ADD CONSTRAINT teras_learning_transition_enrollment_learner_fk
      FOREIGN KEY (enrollment_id, learner_id)
      REFERENCES teras_enrollments (id, learner_id);
  END IF;
END $$;

COMMIT;