#!/bin/bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

: "${DATABASE_URL:?DATABASE_URL must be set}"

schema="teras_diagnostic_provenance_upgrade_test_$$"
cleanup() {
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
    -c "DROP SCHEMA IF EXISTS \"$schema\" CASCADE" >/dev/null
}
trap cleanup EXIT

psql "$DATABASE_URL" -v ON_ERROR_STOP=1 <<SQL >/dev/null
CREATE SCHEMA "$schema";
SET search_path = "$schema";

CREATE TABLE teras_diagnostic_sessions (
  id text PRIMARY KEY, learner_id text NOT NULL, template_id text NOT NULL
);
CREATE TABLE teras_diagnostic_questions (
  id text PRIMARY KEY, template_id text NOT NULL, competency_unit_id text, sequence integer NOT NULL
);
CREATE TABLE teras_diagnostic_options (
  id text PRIMARY KEY, question_id text NOT NULL
);
CREATE TABLE teras_diagnostic_responses (
  id text PRIMARY KEY, session_id text NOT NULL, question_id text NOT NULL,
  option_id text NOT NULL, competency_unit_id text
);
CREATE TABLE teras_diagnostic_profiles (
  id text PRIMARY KEY, session_id text NOT NULL, learner_id text NOT NULL
);
CREATE TABLE teras_diagnostic_profile_items (
  id text PRIMARY KEY, profile_id text NOT NULL, competency_unit_id text NOT NULL,
  unit_code text NOT NULL
);
CREATE TABLE teras_diagnostic_gaps (
  id text PRIMARY KEY, profile_id text NOT NULL, competency_unit_id text NOT NULL,
  unit_code text NOT NULL
);

INSERT INTO teras_diagnostic_sessions VALUES
  ('session-mapped', 'learner-1', 'template-1'),
  ('session-mixed', 'learner-2', 'template-1');
INSERT INTO teras_diagnostic_questions VALUES
  ('question-2', 'template-1', 'unit-1', 2),
  ('question-1', 'template-1', 'unit-1', 1);
INSERT INTO teras_diagnostic_options VALUES
  ('option-2', 'question-2'),
  ('option-1', 'question-1'),
  ('wrong-option', 'question-2');
INSERT INTO teras_diagnostic_responses VALUES
  ('response-2', 'session-mapped', 'question-2', 'option-2', 'unit-1'),
  ('response-1', 'session-mapped', 'question-1', 'option-1', NULL),
  ('mixed-valid', 'session-mixed', 'question-1', 'option-1', 'unit-1'),
  ('mixed-invalid', 'session-mixed', 'question-1', 'wrong-option', 'unit-1');
INSERT INTO teras_diagnostic_profiles VALUES
  ('profile-mapped', 'session-mapped', 'learner-1'),
  ('profile-mixed', 'session-mixed', 'learner-2');
INSERT INTO teras_diagnostic_profile_items VALUES
  ('item-mapped', 'profile-mapped', 'unit-1', 'U1'),
  ('item-mixed', 'profile-mixed', 'unit-1', 'U1');
INSERT INTO teras_diagnostic_gaps VALUES
  ('gap-mapped', 'profile-mapped', 'unit-1', 'U1'),
  ('gap-mixed', 'profile-mixed', 'unit-1', 'U1');
SQL

export PGOPTIONS="-c search_path=$schema"
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
  -f lib/db/migrations/0035_diagnostic_provenance.sql >/dev/null
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
  -f lib/db/migrations/0035_diagnostic_provenance.sql >/dev/null

state="$(psql "$DATABASE_URL" -Atqc "
  SELECT
    (SELECT provenance->'responseIds' FROM teras_diagnostic_profiles WHERE id = 'profile-mapped'),
    (SELECT provenance->'responseIds' FROM teras_diagnostic_profile_items WHERE id = 'item-mapped'),
    (SELECT provenance->'responseIds' FROM teras_diagnostic_gaps WHERE id = 'gap-mapped'),
    (SELECT count(*) FROM teras_diagnostic_provenance_exceptions),
    (SELECT count(*) FROM teras_diagnostic_profiles WHERE id = 'profile-mixed' AND provenance IS NULL),
    (SELECT count(*) FROM teras_diagnostic_profile_items WHERE id = 'item-mixed' AND provenance IS NULL),
    (SELECT count(*) FROM teras_diagnostic_gaps WHERE id = 'gap-mixed' AND provenance IS NULL),
    (SELECT count(*) FROM pg_constraint
      WHERE connamespace = '$schema'::regnamespace
        AND conname LIKE 'teras_diagnostic_%_provenance_check'
        AND convalidated)
")"

expected='["response-1", "response-2"]|["response-1", "response-2"]|["response-1", "response-2"]|3|1|1|1|3'
if [ "$state" != "$expected" ]; then
  echo "Diagnostic provenance migration produced unexpected state: $state" >&2
  exit 1
fi

echo "Diagnostic provenance upgrade migration passed"