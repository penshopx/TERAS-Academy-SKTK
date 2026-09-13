#!/bin/bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

: "${DATABASE_URL:?DATABASE_URL must be set}"

schema="teras_migration_collation_test_$$"
cleanup() {
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
    -c "DROP SCHEMA IF EXISTS \"$schema\" CASCADE" >/dev/null
}
trap cleanup EXIT

psql "$DATABASE_URL" -v ON_ERROR_STOP=1 <<SQL >/dev/null
CREATE SCHEMA "$schema";
CREATE TABLE "$schema".teras_diagnostic_sessions (
  id text PRIMARY KEY,
  learner_id text NOT NULL,
  pathway_id text NOT NULL,
  progress integer NOT NULL,
  status text NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
CREATE TABLE "$schema".teras_diagnostic_audit_events (
  id text PRIMARY KEY,
  session_id text NOT NULL,
  learner_id text NOT NULL,
  action text NOT NULL,
  details jsonb NOT NULL,
  created_by text NOT NULL
);
CREATE TABLE "$schema".teras_enrollment_pathway_events (
  id text PRIMARY KEY,
  enrollment_id text NOT NULL,
  pathway_id text NOT NULL,
  sequence integer NOT NULL,
  created_at timestamptz NOT NULL
);

INSERT INTO "$schema".teras_diagnostic_sessions
  (id, learner_id, pathway_id, progress, status, created_at, updated_at)
VALUES
  ('id-Z', 'learner-1', 'path-1', 50, 'in_progress', '2026-01-01T00:00:00Z', now()),
  ('id-a', 'learner-1', 'path-1', 50, 'in_progress', '2026-01-01T00:00:00Z', now());

INSERT INTO "$schema".teras_enrollment_pathway_events
  (id, enrollment_id, pathway_id, sequence, created_at)
VALUES
  ('id-Z', 'enrollment-1', 'path-Z', 7, '2026-01-01T00:00:00Z'),
  ('id-a', 'enrollment-1', 'path-a', 7, '2026-01-01T00:00:00Z');
SQL

export PGOPTIONS="-c search_path=$schema"
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
  -f lib/db/migrations/0020_diagnostic_single_active_session.sql >/dev/null

state="$(psql "$DATABASE_URL" -Atv ON_ERROR_STOP=1 <<'SQL'
SELECT
  (SELECT id
   FROM teras_diagnostic_sessions
   WHERE status = 'in_progress'),
  (SELECT details->>'canonicalSessionId'
   FROM teras_diagnostic_audit_events
   WHERE action = 'diagnostic_session_superseded'),
  (SELECT selection.pathway_id
   FROM teras_enrollment_pathway_events selection
   WHERE selection.enrollment_id = 'enrollment-1'
     AND selection.created_at <= '2026-01-01T00:00:00Z'
   ORDER BY selection.sequence DESC,
            selection.created_at DESC,
            selection.id COLLATE "C" DESC
   LIMIT 1),
  (SELECT selection.pathway_id
   FROM teras_enrollment_pathway_events selection
   WHERE selection.enrollment_id = 'enrollment-1'
   ORDER BY selection.sequence DESC,
            selection.created_at DESC,
            selection.id COLLATE "C" DESC
   LIMIT 1);
SQL
)"

if [ "$state" != "id-Z|id-Z|path-a|path-a" ]; then
  echo "Migration winner selection was not bytewise deterministic: $state" >&2
  exit 1
fi

echo "Migration collation upgrade rehearsal passed"