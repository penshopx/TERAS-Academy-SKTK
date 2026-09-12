BEGIN;

-- Enrollment-backed context inventory:
--   completion: effective enrollment pathway + activity pathway
--   outcome verification: effective enrollment pathway + activity pathway + outcome activity
--   readiness transfer: enrollment program + effective enrollment pathway
--   learning transition: enrollment program + effective enrollment pathway + activity context
--   readiness decision: effective enrollment pathway + gate pathway
-- Effective pathway means the latest pathway-selection event at the audited
-- event timestamp, falling back to the enrollment's original assignment.
LOCK TABLE
  teras_enrollments,
  teras_enrollment_pathway_events,
  teras_learning_activities,
  teras_learning_outcomes,
  teras_readiness_gates,
  teras_activity_completion_events,
  teras_outcome_verification_events,
  teras_readiness_transfer_events,
  teras_learning_transition_events,
  teras_readiness_events
  IN SHARE ROW EXCLUSIVE MODE;

-- The canonical shared demo fixture predates append-only pathway selection
-- records and was repeatedly exercised on both pathways by integration tests.
-- Recover only that known fixture, and only when it has no selection history:
-- infer each pathway change from immutable event chronology while leaving every
-- source event untouched. Never infer history for real learner enrollments;
-- their missing context is ambiguous and must remain a hard migration failure.
WITH event_context AS (
  SELECT enrollment_id, pathway_id, created_at, id, 1 AS source_order
  FROM teras_activity_completion_events
  UNION ALL
  SELECT enrollment_id, pathway_id, created_at, id, 2
  FROM teras_outcome_verification_events
  UNION ALL
  SELECT enrollment_id, pathway_id, created_at, id, 3
  FROM teras_readiness_transfer_events
  UNION ALL
  SELECT enrollment_id, pathway_id, created_at, id, 4
  FROM teras_learning_transition_events
  UNION ALL
  SELECT enrollment_id, pathway_id, created_at, id, 5
  FROM teras_readiness_events
),
recoverable AS (
  SELECT
    event.*,
    enrollment.program_id,
    enrollment.pathway_id AS original_pathway_id,
    lag(event.pathway_id, 1, enrollment.pathway_id) OVER (
      PARTITION BY event.enrollment_id
      ORDER BY event.created_at, event.source_order, event.id
    ) AS previous_pathway_id
  FROM event_context event
  JOIN teras_enrollments enrollment ON enrollment.id = event.enrollment_id
  WHERE enrollment.id = 'enrol-demo'
    AND enrollment.learner_id = 'learner-demo'
    AND NOT EXISTS (
    SELECT 1
    FROM teras_enrollment_pathway_events selection
    WHERE selection.enrollment_id = event.enrollment_id
  )
),
changes AS (
  SELECT
    recoverable.*,
    row_number() OVER (
      PARTITION BY recoverable.enrollment_id
      ORDER BY recoverable.created_at, recoverable.source_order, recoverable.id
    ) AS recovered_sequence
  FROM recoverable
  WHERE recoverable.pathway_id <> recoverable.previous_pathway_id
)
INSERT INTO teras_enrollment_pathway_events (
  id,
  enrollment_id,
  pathway_id,
  program_id,
  sequence,
  created_at,
  created_by
)
SELECT
  'migration-0033-' || md5(
    changes.enrollment_id || ':' ||
    changes.created_at::text || ':' ||
    changes.pathway_id || ':' ||
    changes.recovered_sequence::text
  ),
  changes.enrollment_id,
  changes.pathway_id,
  changes.program_id,
  changes.recovered_sequence::integer,
  changes.created_at,
  'migration-0033-context-recovery'
FROM changes
ON CONFLICT DO NOTHING;

DO $$
DECLARE
  mismatch_table text;
BEGIN
  SELECT source_table INTO mismatch_table
  FROM (
    SELECT 'teras_activity_completion_events' AS source_table
    FROM teras_activity_completion_events event
    JOIN teras_enrollments enrollment ON enrollment.id = event.enrollment_id
    JOIN teras_learning_activities activity ON activity.id = event.activity_id
    LEFT JOIN LATERAL (
      SELECT selection.pathway_id
      FROM teras_enrollment_pathway_events selection
      WHERE selection.enrollment_id = event.enrollment_id
        AND selection.created_at <= event.created_at
      ORDER BY selection.sequence DESC, selection.created_at DESC, selection.id DESC
      LIMIT 1
    ) active ON true
    WHERE event.pathway_id <> COALESCE(active.pathway_id, enrollment.pathway_id)
       OR event.pathway_id <> activity.pathway_id
    UNION ALL
    SELECT 'teras_outcome_verification_events'
    FROM teras_outcome_verification_events event
    JOIN teras_enrollments enrollment ON enrollment.id = event.enrollment_id
    JOIN teras_learning_activities activity ON activity.id = event.activity_id
    JOIN teras_learning_outcomes outcome ON outcome.id = event.outcome_id
    LEFT JOIN LATERAL (
      SELECT selection.pathway_id
      FROM teras_enrollment_pathway_events selection
      WHERE selection.enrollment_id = event.enrollment_id
        AND selection.created_at <= event.created_at
      ORDER BY selection.sequence DESC, selection.created_at DESC, selection.id DESC
      LIMIT 1
    ) active ON true
    WHERE event.pathway_id <> COALESCE(active.pathway_id, enrollment.pathway_id)
       OR event.pathway_id <> activity.pathway_id
       OR event.activity_id <> outcome.activity_id
    UNION ALL
    SELECT 'teras_readiness_transfer_events'
    FROM teras_readiness_transfer_events event
    JOIN teras_enrollments enrollment ON enrollment.id = event.enrollment_id
    LEFT JOIN LATERAL (
      SELECT selection.pathway_id
      FROM teras_enrollment_pathway_events selection
      WHERE selection.enrollment_id = event.enrollment_id
        AND selection.created_at <= event.created_at
      ORDER BY selection.sequence DESC, selection.created_at DESC, selection.id DESC
      LIMIT 1
    ) active ON true
    WHERE event.program_id <> enrollment.program_id
       OR event.pathway_id <> COALESCE(active.pathway_id, enrollment.pathway_id)
    UNION ALL
    SELECT 'teras_learning_transition_events'
    FROM teras_learning_transition_events event
    JOIN teras_enrollments enrollment ON enrollment.id = event.enrollment_id
    JOIN teras_learning_activities activity ON activity.id = event.activity_id
    LEFT JOIN LATERAL (
      SELECT selection.pathway_id
      FROM teras_enrollment_pathway_events selection
      WHERE selection.enrollment_id = event.enrollment_id
        AND selection.created_at <= event.created_at
      ORDER BY selection.sequence DESC, selection.created_at DESC, selection.id DESC
      LIMIT 1
    ) active ON true
    WHERE event.program_id <> enrollment.program_id
       OR event.pathway_id <> COALESCE(active.pathway_id, enrollment.pathway_id)
       OR (event.program_id, event.pathway_id)
          IS DISTINCT FROM (activity.program_id, activity.pathway_id)
    UNION ALL
    SELECT 'teras_readiness_events'
    FROM teras_readiness_events event
    JOIN teras_enrollments enrollment ON enrollment.id = event.enrollment_id
    JOIN teras_readiness_gates gate ON gate.id = event.gate_id
    LEFT JOIN LATERAL (
      SELECT selection.pathway_id
      FROM teras_enrollment_pathway_events selection
      WHERE selection.enrollment_id = event.enrollment_id
        AND selection.created_at <= event.created_at
      ORDER BY selection.sequence DESC, selection.created_at DESC, selection.id DESC
      LIMIT 1
    ) active ON true
    WHERE event.pathway_id <> COALESCE(active.pathway_id, enrollment.pathway_id)
       OR event.pathway_id <> gate.pathway_id
  ) mismatches
  LIMIT 1;

  IF mismatch_table IS NOT NULL THEN
    RAISE EXCEPTION
      'Cannot enforce enrollment event context: program or pathway mismatch in %',
      mismatch_table;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'teras_learning_activities_id_pathway_unique' AND conrelid = 'teras_learning_activities'::regclass)
     AND to_regclass('teras_learning_activities_id_pathway_unique') IS NOT NULL THEN
    ALTER TABLE teras_learning_activities
      ADD CONSTRAINT teras_learning_activities_id_pathway_unique
      UNIQUE USING INDEX teras_learning_activities_id_pathway_unique;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'teras_learning_activities_id_program_pathway_unique' AND conrelid = 'teras_learning_activities'::regclass) THEN
    ALTER TABLE teras_learning_activities ADD CONSTRAINT teras_learning_activities_id_program_pathway_unique UNIQUE (id, program_id, pathway_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'teras_learning_outcomes_id_activity_unique' AND conrelid = 'teras_learning_outcomes'::regclass) THEN
    ALTER TABLE teras_learning_outcomes ADD CONSTRAINT teras_learning_outcomes_id_activity_unique UNIQUE (id, activity_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'teras_readiness_gates_id_pathway_unique' AND conrelid = 'teras_readiness_gates'::regclass) THEN
    ALTER TABLE teras_readiness_gates ADD CONSTRAINT teras_readiness_gates_id_pathway_unique UNIQUE (id, pathway_id);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'teras_activity_completion_activity_pathway_fk' AND conrelid = 'teras_activity_completion_events'::regclass) THEN
    ALTER TABLE teras_activity_completion_events ADD CONSTRAINT teras_activity_completion_activity_pathway_fk FOREIGN KEY (activity_id, pathway_id) REFERENCES teras_learning_activities (id, pathway_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'teras_outcome_verification_activity_pathway_fk' AND conrelid = 'teras_outcome_verification_events'::regclass) THEN
    ALTER TABLE teras_outcome_verification_events ADD CONSTRAINT teras_outcome_verification_activity_pathway_fk FOREIGN KEY (activity_id, pathway_id) REFERENCES teras_learning_activities (id, pathway_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'teras_outcome_verification_outcome_activity_fk' AND conrelid = 'teras_outcome_verification_events'::regclass) THEN
    ALTER TABLE teras_outcome_verification_events ADD CONSTRAINT teras_outcome_verification_outcome_activity_fk FOREIGN KEY (outcome_id, activity_id) REFERENCES teras_learning_outcomes (id, activity_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'teras_readiness_transfer_enrollment_program_fk' AND conrelid = 'teras_readiness_transfer_events'::regclass) THEN
    ALTER TABLE teras_readiness_transfer_events ADD CONSTRAINT teras_readiness_transfer_enrollment_program_fk FOREIGN KEY (enrollment_id, program_id) REFERENCES teras_enrollments (id, program_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'teras_learning_transition_enrollment_program_fk' AND conrelid = 'teras_learning_transition_events'::regclass) THEN
    ALTER TABLE teras_learning_transition_events ADD CONSTRAINT teras_learning_transition_enrollment_program_fk FOREIGN KEY (enrollment_id, program_id) REFERENCES teras_enrollments (id, program_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'teras_learning_transition_activity_context_fk' AND conrelid = 'teras_learning_transition_events'::regclass) THEN
    ALTER TABLE teras_learning_transition_events ADD CONSTRAINT teras_learning_transition_activity_context_fk FOREIGN KEY (activity_id, program_id, pathway_id) REFERENCES teras_learning_activities (id, program_id, pathway_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'teras_readiness_events_gate_pathway_fk' AND conrelid = 'teras_readiness_events'::regclass) THEN
    ALTER TABLE teras_readiness_events ADD CONSTRAINT teras_readiness_events_gate_pathway_fk FOREIGN KEY (gate_id, pathway_id) REFERENCES teras_readiness_gates (id, pathway_id);
  END IF;
END $$;

CREATE OR REPLACE FUNCTION teras_enforce_event_enrollment_context()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  enrollment_program_id text;
  effective_pathway_id text;
  event_program_id text;
BEGIN
  SELECT enrollment.program_id,
         COALESCE((
           SELECT selection.pathway_id
           FROM teras_enrollment_pathway_events selection
           WHERE selection.enrollment_id = NEW.enrollment_id
             AND selection.created_at <= NEW.created_at
           ORDER BY selection.sequence DESC, selection.created_at DESC, selection.id DESC
           LIMIT 1
         ), enrollment.pathway_id)
  INTO enrollment_program_id, effective_pathway_id
  FROM teras_enrollments enrollment
  WHERE enrollment.id = NEW.enrollment_id
  FOR UPDATE;

  event_program_id := to_jsonb(NEW)->>'program_id';
  IF effective_pathway_id IS NULL
     OR NEW.pathway_id <> effective_pathway_id
     OR (event_program_id IS NOT NULL AND event_program_id <> enrollment_program_id) THEN
    RAISE foreign_key_violation
      USING MESSAGE = format('Event context does not match enrollment %s at event time', NEW.enrollment_id),
            CONSTRAINT = TG_NAME;
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION teras_guard_enrollment_pathway_history()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  latest_recorded_at timestamptz;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE check_violation
      USING MESSAGE = 'Enrollment pathway history is append-only',
            CONSTRAINT = TG_NAME;
  END IF;

  PERFORM 1
  FROM teras_enrollments
  WHERE id = NEW.enrollment_id
  FOR UPDATE;

  SELECT max(recorded_at) INTO latest_recorded_at
  FROM (
    SELECT max(created_at) AS recorded_at
    FROM teras_enrollment_pathway_events
    WHERE enrollment_id = NEW.enrollment_id
    UNION ALL
    SELECT max(created_at) FROM teras_activity_completion_events WHERE enrollment_id = NEW.enrollment_id
    UNION ALL
    SELECT max(created_at) FROM teras_outcome_verification_events WHERE enrollment_id = NEW.enrollment_id
    UNION ALL
    SELECT max(created_at) FROM teras_readiness_transfer_events WHERE enrollment_id = NEW.enrollment_id
    UNION ALL
    SELECT max(created_at) FROM teras_learning_transition_events WHERE enrollment_id = NEW.enrollment_id
    UNION ALL
    SELECT max(created_at) FROM teras_readiness_events WHERE enrollment_id = NEW.enrollment_id
  ) recorded;

  IF NEW.created_at > clock_timestamp()
     OR (latest_recorded_at IS NOT NULL AND NEW.created_at <= latest_recorded_at) THEN
    RAISE check_violation
      USING MESSAGE = 'Enrollment pathway selection cannot reinterpret existing event history',
            CONSTRAINT = TG_NAME;
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION teras_guard_enrollment_context_identity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF (NEW.program_id, NEW.pathway_id)
     IS DISTINCT FROM (OLD.program_id, OLD.pathway_id) THEN
    RAISE check_violation
      USING MESSAGE = 'Enrollment program and original pathway are immutable; append a pathway event instead',
            CONSTRAINT = TG_NAME;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS teras_enrollment_context_identity_guard ON teras_enrollments;
CREATE TRIGGER teras_enrollment_context_identity_guard
BEFORE UPDATE OF program_id, pathway_id
ON teras_enrollments
FOR EACH ROW EXECUTE FUNCTION teras_guard_enrollment_context_identity();

DROP TRIGGER IF EXISTS teras_enrollment_pathway_history_guard ON teras_enrollment_pathway_events;
CREATE TRIGGER teras_enrollment_pathway_history_guard
BEFORE INSERT OR UPDATE OR DELETE
ON teras_enrollment_pathway_events
FOR EACH ROW EXECUTE FUNCTION teras_guard_enrollment_pathway_history();

DROP TRIGGER IF EXISTS teras_activity_completion_enrollment_context_guard ON teras_activity_completion_events;
CREATE TRIGGER teras_activity_completion_enrollment_context_guard
BEFORE INSERT OR UPDATE OF enrollment_id, pathway_id, created_at
ON teras_activity_completion_events
FOR EACH ROW EXECUTE FUNCTION teras_enforce_event_enrollment_context();

DROP TRIGGER IF EXISTS teras_outcome_verification_enrollment_context_guard ON teras_outcome_verification_events;
CREATE TRIGGER teras_outcome_verification_enrollment_context_guard
BEFORE INSERT OR UPDATE OF enrollment_id, pathway_id, created_at
ON teras_outcome_verification_events
FOR EACH ROW EXECUTE FUNCTION teras_enforce_event_enrollment_context();

DROP TRIGGER IF EXISTS teras_readiness_transfer_enrollment_context_guard ON teras_readiness_transfer_events;
CREATE TRIGGER teras_readiness_transfer_enrollment_context_guard
BEFORE INSERT OR UPDATE OF enrollment_id, program_id, pathway_id, created_at
ON teras_readiness_transfer_events
FOR EACH ROW EXECUTE FUNCTION teras_enforce_event_enrollment_context();

DROP TRIGGER IF EXISTS teras_learning_transition_enrollment_context_guard ON teras_learning_transition_events;
CREATE TRIGGER teras_learning_transition_enrollment_context_guard
BEFORE INSERT OR UPDATE OF enrollment_id, program_id, pathway_id, created_at
ON teras_learning_transition_events
FOR EACH ROW EXECUTE FUNCTION teras_enforce_event_enrollment_context();

DROP TRIGGER IF EXISTS teras_readiness_events_enrollment_context_guard ON teras_readiness_events;
CREATE TRIGGER teras_readiness_events_enrollment_context_guard
BEFORE INSERT OR UPDATE OF enrollment_id, pathway_id, created_at
ON teras_readiness_events
FOR EACH ROW EXECUTE FUNCTION teras_enforce_event_enrollment_context();

COMMIT;