BEGIN;

LOCK TABLE teras_diagnostic_sessions, teras_diagnostic_audit_events
  IN SHARE ROW EXCLUSIVE MODE;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM teras_diagnostic_audit_events AS audit_event
    JOIN teras_diagnostic_sessions AS session
      ON session.id = audit_event.session_id
    WHERE audit_event.learner_id <> session.learner_id
  ) THEN
    RAISE EXCEPTION
      'Cannot enforce diagnostic audit ownership: an audit event learner differs from its session owner';
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'teras_diagnostic_sessions_id_learner_unique'
      AND conrelid = 'teras_diagnostic_sessions'::regclass
  ) THEN
    ALTER TABLE teras_diagnostic_sessions
      ADD CONSTRAINT teras_diagnostic_sessions_id_learner_unique
      UNIQUE (id, learner_id);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'teras_diagnostic_audit_events_session_learner_fk'
      AND conrelid = 'teras_diagnostic_audit_events'::regclass
  ) THEN
    ALTER TABLE teras_diagnostic_audit_events
      DROP CONSTRAINT IF EXISTS teras_diagnostic_audit_events_session_id_teras_diagnostic_sessions_id_fk,
      ADD CONSTRAINT teras_diagnostic_audit_events_session_learner_fk
      FOREIGN KEY (session_id, learner_id)
      REFERENCES teras_diagnostic_sessions (id, learner_id)
      ON DELETE CASCADE;
  END IF;
END $$;

COMMIT;