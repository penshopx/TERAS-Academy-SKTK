BEGIN;

LOCK TABLE teras_diagnostic_sessions, teras_diagnostic_profiles
  IN SHARE ROW EXCLUSIVE MODE;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM teras_diagnostic_profiles AS profile
    JOIN teras_diagnostic_sessions AS session
      ON session.id = profile.session_id
    WHERE profile.learner_id <> session.learner_id
  ) THEN
    RAISE EXCEPTION
      'Cannot enforce diagnostic profile ownership: a profile learner differs from its session owner';
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
    WHERE conname = 'teras_diagnostic_profiles_session_learner_fk'
      AND conrelid = 'teras_diagnostic_profiles'::regclass
  ) THEN
    ALTER TABLE teras_diagnostic_profiles
      ADD CONSTRAINT teras_diagnostic_profiles_session_learner_fk
      FOREIGN KEY (session_id, learner_id)
      REFERENCES teras_diagnostic_sessions (id, learner_id);
  END IF;
END $$;

COMMIT;