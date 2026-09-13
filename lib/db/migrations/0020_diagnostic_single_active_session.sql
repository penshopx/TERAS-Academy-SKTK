BEGIN;

LOCK TABLE teras_diagnostic_sessions IN SHARE ROW EXCLUSIVE MODE;

WITH ranked_active_sessions AS (
  SELECT
    session.id,
    first_value(session.id) OVER (
      PARTITION BY session.learner_id, session.pathway_id
      ORDER BY session.progress DESC, session.created_at ASC, session.id COLLATE "C" ASC
    ) AS canonical_session_id,
    row_number() OVER (
      PARTITION BY session.learner_id, session.pathway_id
      ORDER BY session.progress DESC, session.created_at ASC, session.id COLLATE "C" ASC
    ) AS active_rank
  FROM teras_diagnostic_sessions AS session
  WHERE session.status = 'in_progress'
),
superseded_sessions AS (
  UPDATE teras_diagnostic_sessions AS session
  SET status = 'superseded', updated_at = now()
  FROM ranked_active_sessions AS ranked
  WHERE session.id = ranked.id
    AND ranked.active_rank > 1
  RETURNING session.id, session.learner_id, ranked.canonical_session_id
)
INSERT INTO teras_diagnostic_audit_events (
  id, session_id, learner_id, action, details, created_by
)
SELECT
  'diagnostic-audit-single-active-' || md5(session.id),
  session.id,
  session.learner_id,
  'diagnostic_session_superseded',
  jsonb_build_object('canonicalSessionId', session.canonical_session_id),
  'system'
FROM superseded_sessions AS session
ON CONFLICT (id) DO NOTHING;

CREATE UNIQUE INDEX IF NOT EXISTS teras_diagnostic_sessions_one_active_unique
  ON teras_diagnostic_sessions (learner_id, pathway_id)
  WHERE status = 'in_progress';

COMMIT;