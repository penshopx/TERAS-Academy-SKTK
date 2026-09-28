#!/bin/bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

: "${DATABASE_URL:?DATABASE_URL must be set}"

schema="teras_diagnostic_provenance_upgrade_test_$$"
check_sql="$(mktemp)"
cleanup() {
  rm -f "$check_sql"
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
    (SELECT count(*) FROM teras_diagnostic_provenance_check_runs),
    (SELECT count(*) FROM teras_diagnostic_provenance_check_counts),
    (SELECT count(*) FROM pg_constraint
      WHERE connamespace = '$schema'::regnamespace
        AND conname LIKE 'teras_diagnostic_%_provenance_check'
        AND convalidated)
")"

expected='["response-1", "response-2"]|["response-1", "response-2"]|["response-1", "response-2"]|3|1|1|1|0|0|3'
if [ "$state" != "$expected" ]; then
  echo "Diagnostic provenance migration produced unexpected state: $state" >&2
  exit 1
fi

awk '
  /^DO \$\$$/ {
    block = $0 ORS
    capture = 1
    next
  }
  capture {
    block = block $0 ORS
    if ($0 == "END $$;") {
      if (block ~ /teras_diagnostic_provenance_schema_check/) {
        printf "%s", block
      }
      block = ""
      capture = 0
    }
  }
' scripts/schema-check.sql >"$check_sql"

if ! grep -q "teras_diagnostic_provenance_schema_check" "$check_sql"; then
  echo "Could not extract diagnostic provenance aggregate check" >&2
  exit 1
fi

run_schema_check() {
  local output_file="$1"
  PGAPPNAME="${2:-diagnostic-provenance-schema-check}" \
    psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$check_sql" >"$output_file" 2>&1
}

assert_contains() {
  local output_file="$1"
  local expected_text="$2"
  if ! grep -Fq "$expected_text" "$output_file"; then
    echo "Expected schema-check output was missing: $expected_text" >&2
    cat "$output_file" >&2
    exit 1
  fi
}

assert_no_increase_warning() {
  local output_file="$1"
  if grep -Fq "TERAS_DIAGNOSTIC_PROVENANCE_EXCEPTIONS_INCREASE" "$output_file"; then
    echo "Schema-check unexpectedly emitted an increase warning" >&2
    cat "$output_file" >&2
    exit 1
  fi
}

assert_output_is_aggregate_only() {
  local output_file="$1"
  if grep -Eq \
    'learner-[0-9]+|session-|profile-|item-|gap-|response-|parallel-sensitive-detail' \
    "$output_file"; then
    echo "Schema-check output leaked learner or exception details" >&2
    cat "$output_file" >&2
    exit 1
  fi
}

baseline_output="$(mktemp)"
second_output="$(mktemp)"
cancelled_output="$(mktemp)"
post_cancel_output="$(mktemp)"
parallel_a_output="$(mktemp)"
parallel_b_output="$(mktemp)"
decrease_output="$(mktemp)"
lock_ready_file="$(mktemp)"
rm -f "$lock_ready_file"
cancel_lock_ready_file="$(mktemp)"
rm -f "$cancel_lock_ready_file"
trap 'rm -f "$check_sql" "$baseline_output" "$second_output" "$cancelled_output" "$post_cancel_output" "$parallel_a_output" "$parallel_b_output" "$decrease_output" "$lock_ready_file" "$cancel_lock_ready_file"; cleanup' EXIT

run_schema_check "$baseline_output"
assert_contains "$baseline_output" \
  "TERAS_DIAGNOSTIC_PROVENANCE_EXCEPTIONS entity_type=profile reason=NO_VALID_RESPONSE_CHAIN count=1 delta=1"
assert_no_increase_warning "$baseline_output"
assert_output_is_aggregate_only "$baseline_output"

psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c "
  INSERT INTO teras_diagnostic_provenance_exceptions
    (entity_type, entity_id, profile_id, session_id, reason, details)
  VALUES (
    'profile',
    'sequential-sensitive-id',
    'profile-sequential-sensitive-id',
    'session-sequential-sensitive-id',
    'NO_VALID_RESPONSE_CHAIN',
    '{\"private\":\"learner-sequential-sensitive-id\"}'::jsonb
  )
" >/dev/null

run_schema_check "$second_output"
assert_contains "$second_output" \
  "TERAS_DIAGNOSTIC_PROVENANCE_EXCEPTIONS_INCREASE entity_type=profile reason=NO_VALID_RESPONSE_CHAIN previous_count=1 current_count=2 delta=1"
assert_output_is_aggregate_only "$second_output"

psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c "
  INSERT INTO teras_diagnostic_provenance_exceptions
    (entity_type, entity_id, profile_id, session_id, reason, details)
  VALUES (
    'profile',
    'cancel-sensitive-id',
    'profile-cancel-sensitive-id',
    'session-cancel-sensitive-id',
    'NO_VALID_RESPONSE_CHAIN',
    '{\"private\":\"learner-cancel-sensitive-id\"}'::jsonb
  );

  CREATE FUNCTION block_cancelled_check_count_insert()
  RETURNS trigger
  LANGUAGE plpgsql
  AS \$\$
  BEGIN
    PERFORM pg_advisory_xact_lock(hashtext('teras_diagnostic_provenance_cancel_fixture'));
    RETURN NEW;
  END;
  \$\$;

  CREATE TRIGGER block_cancelled_check_count_insert
  BEFORE INSERT ON teras_diagnostic_provenance_check_counts
  FOR EACH ROW
  EXECUTE FUNCTION block_cancelled_check_count_insert();
" >/dev/null

pre_cancel_state="$(psql "$DATABASE_URL" -Atqc "
  SELECT
    (SELECT count(*) FROM teras_diagnostic_provenance_check_runs),
    (SELECT count(*) FROM teras_diagnostic_provenance_check_counts),
    (SELECT max(id) FROM teras_diagnostic_provenance_check_runs)
")"

PGAPPNAME="diagnostic-provenance-cancel-lock-holder" psql "$DATABASE_URL" \
  -v ON_ERROR_STOP=1 <<SQL >/dev/null &
    SELECT pg_advisory_lock(hashtext('teras_diagnostic_provenance_cancel_fixture'));
\! touch "$cancel_lock_ready_file"
    SELECT pg_sleep(30);
    SELECT pg_advisory_unlock(hashtext('teras_diagnostic_provenance_cancel_fixture'));
SQL
cancel_lock_holder_pid=$!

for _ in $(seq 1 50); do
  if [ -f "$cancel_lock_ready_file" ]; then
    break
  fi
  sleep 0.1
done

if [ ! -f "$cancel_lock_ready_file" ]; then
  echo "Cancellation fixture did not acquire its advisory lock" >&2
  wait "$cancel_lock_holder_pid" || true
  exit 1
fi

run_schema_check "$cancelled_output" "diagnostic-provenance-cancelled-check" &
cancelled_check_pid=$!
cancelled_backend_pid=""
for _ in $(seq 1 50); do
  cancelled_backend_pid="$(psql "$DATABASE_URL" -Atqc "
    SELECT pid
    FROM pg_stat_activity
    WHERE application_name = 'diagnostic-provenance-cancelled-check'
      AND wait_event = 'advisory'
    LIMIT 1
  ")"
  if [ -n "$cancelled_backend_pid" ]; then
    break
  fi
  sleep 0.1
done

if [ -z "$cancelled_backend_pid" ]; then
  echo "Schema check was not observed after creating its run and before inserting counts" >&2
  wait "$cancelled_check_pid" || true
  kill "$cancel_lock_holder_pid" 2>/dev/null || true
  wait "$cancel_lock_holder_pid" || true
  exit 1
fi

psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c \
  "SELECT pg_terminate_backend($cancelled_backend_pid)" >/dev/null
if wait "$cancelled_check_pid"; then
  echo "Cancelled schema check unexpectedly completed successfully" >&2
  kill "$cancel_lock_holder_pid" 2>/dev/null || true
  wait "$cancel_lock_holder_pid" || true
  exit 1
fi

kill "$cancel_lock_holder_pid" 2>/dev/null || true
wait "$cancel_lock_holder_pid" || true

post_cancel_state="$(psql "$DATABASE_URL" -Atqc "
  SELECT
    (SELECT count(*) FROM teras_diagnostic_provenance_check_runs),
    (SELECT count(*) FROM teras_diagnostic_provenance_check_counts),
    (SELECT max(id) FROM teras_diagnostic_provenance_check_runs)
")"
if [ "$post_cancel_state" != "$pre_cancel_state" ]; then
  echo "Cancelled schema check left a partial run or count snapshot: before=$pre_cancel_state after=$post_cancel_state" >&2
  exit 1
fi

main_lock_released="$(psql "$DATABASE_URL" -Atqc "
  SELECT pg_try_advisory_lock(hashtext('teras_diagnostic_provenance_schema_check'));
  SELECT pg_advisory_unlock(hashtext('teras_diagnostic_provenance_schema_check'));
")"
if [ "$main_lock_released" != $'t\nt' ]; then
  echo "Cancelled schema check did not release its transaction advisory lock" >&2
  exit 1
fi

psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c "
  DROP TRIGGER block_cancelled_check_count_insert
    ON teras_diagnostic_provenance_check_counts;
  DROP FUNCTION block_cancelled_check_count_insert();
" >/dev/null

run_schema_check "$post_cancel_output"
assert_contains "$post_cancel_output" \
  "TERAS_DIAGNOSTIC_PROVENANCE_EXCEPTIONS_INCREASE entity_type=profile reason=NO_VALID_RESPONSE_CHAIN previous_count=2 current_count=3 delta=1"
assert_output_is_aggregate_only "$post_cancel_output"

PGAPPNAME="diagnostic-provenance-lock-holder" psql "$DATABASE_URL" \
  -v ON_ERROR_STOP=1 <<SQL >/dev/null &
    BEGIN;
    SELECT pg_advisory_xact_lock(hashtext('teras_diagnostic_provenance_schema_check'));
\! touch "$lock_ready_file"
    SELECT pg_sleep(5);
    INSERT INTO teras_diagnostic_provenance_exceptions
      (entity_type, entity_id, profile_id, session_id, reason, details)
    VALUES (
      'profile',
      'parallel-sensitive-id',
      'profile-parallel-sensitive-id',
      'session-parallel-sensitive-id',
      'NO_VALID_RESPONSE_CHAIN',
      '{"private":"parallel-sensitive-detail"}'::jsonb
    );
    COMMIT;
SQL
lock_holder_pid=$!

for _ in $(seq 1 50); do
  if [ -f "$lock_ready_file" ]; then
    break
  fi
  sleep 0.1
done

if [ ! -f "$lock_ready_file" ]; then
  echo "Parallel schema-check fixture did not acquire its advisory lock" >&2
  wait "$lock_holder_pid" || true
  exit 1
fi

run_schema_check "$parallel_a_output" "diagnostic-provenance-parallel-a" &
parallel_a_pid=$!
run_schema_check "$parallel_b_output" "diagnostic-provenance-parallel-b" &
parallel_b_pid=$!

for _ in $(seq 1 50); do
  waiting_check_count="$(psql "$DATABASE_URL" -Atqc "
    SELECT count(*)
    FROM pg_stat_activity
    WHERE application_name IN (
      'diagnostic-provenance-parallel-a',
      'diagnostic-provenance-parallel-b'
    )
      AND wait_event = 'advisory'
  ")"
  if [ "$waiting_check_count" -eq 2 ]; then
    break
  fi
  sleep 0.1
done

if [ "${waiting_check_count:-0}" -ne 2 ]; then
  echo "Both parallel schema checks were not observed waiting on the advisory lock" >&2
  wait "$lock_holder_pid" || true
  wait "$parallel_a_pid" || true
  wait "$parallel_b_pid" || true
  exit 1
fi

wait "$lock_holder_pid"
wait "$parallel_a_pid"
wait "$parallel_b_pid"

parallel_output="$(cat "$parallel_a_output" "$parallel_b_output")"
parallel_warning_count="$(
  grep -Fc \
    "TERAS_DIAGNOSTIC_PROVENANCE_EXCEPTIONS_INCREASE entity_type=profile reason=NO_VALID_RESPONSE_CHAIN previous_count=3 current_count=4 delta=1" \
    <<<"$parallel_output" || true
)"
parallel_zero_delta_count="$(
  grep -Fc \
    "TERAS_DIAGNOSTIC_PROVENANCE_EXCEPTIONS entity_type=profile reason=NO_VALID_RESPONSE_CHAIN count=4 delta=0" \
    <<<"$parallel_output" || true
)"

if [ "$parallel_warning_count" -ne 1 ] || [ "$parallel_zero_delta_count" -ne 1 ]; then
  echo "Parallel schema checks did not serialize against the immediately preceding snapshot" >&2
  printf '%s\n' "$parallel_output" >&2
  exit 1
fi

assert_output_is_aggregate_only "$parallel_a_output"
assert_output_is_aggregate_only "$parallel_b_output"

psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c "
  DELETE FROM teras_diagnostic_provenance_exceptions
  WHERE entity_type = 'profile'
    AND entity_id = 'sequential-sensitive-id'
    AND reason = 'NO_VALID_RESPONSE_CHAIN'
" >/dev/null

run_schema_check "$decrease_output"
assert_contains "$decrease_output" \
  "TERAS_DIAGNOSTIC_PROVENANCE_EXCEPTIONS entity_type=profile reason=NO_VALID_RESPONSE_CHAIN count=3 delta=-1"
assert_no_increase_warning "$decrease_output"
assert_output_is_aggregate_only "$decrease_output"

exception_count_before_retention="$(
  psql "$DATABASE_URL" -Atqc \
    "SELECT count(*) FROM teras_diagnostic_provenance_exceptions"
)"
exception_group_count="$(
  psql "$DATABASE_URL" -Atqc "
    SELECT count(*)
    FROM (
      SELECT entity_type, reason
      FROM teras_diagnostic_provenance_exceptions
      GROUP BY entity_type, reason
    ) grouped_exceptions
  "
)"

psql "$DATABASE_URL" -v ON_ERROR_STOP=1 <<'SQL' >/dev/null
INSERT INTO teras_diagnostic_provenance_check_runs (checked_at)
SELECT clock_timestamp() - make_interval(secs => generated.offset_seconds)
FROM generate_series(1, 35) AS generated(offset_seconds);

INSERT INTO teras_diagnostic_provenance_check_counts
  (check_run_id, entity_type, reason, exception_count)
SELECT
  run.id,
  'profile',
  'NO_VALID_RESPONSE_CHAIN',
  3
FROM teras_diagnostic_provenance_check_runs run
WHERE NOT EXISTS (
  SELECT 1
  FROM teras_diagnostic_provenance_check_counts count_snapshot
  WHERE count_snapshot.check_run_id = run.id
);
SQL

retention_first_output="$(mktemp)"
retention_second_output="$(mktemp)"
trap 'rm -f "$check_sql" "$baseline_output" "$second_output" "$cancelled_output" "$post_cancel_output" "$parallel_a_output" "$parallel_b_output" "$decrease_output" "$retention_first_output" "$retention_second_output" "$lock_ready_file" "$cancel_lock_ready_file"; cleanup' EXIT

run_schema_check "$retention_first_output"
first_retained_state="$(psql "$DATABASE_URL" -Atqc "
  SELECT
    (SELECT count(*) FROM teras_diagnostic_provenance_check_runs),
    (SELECT max(id) FROM teras_diagnostic_provenance_check_runs),
    (SELECT count(*) FROM teras_diagnostic_provenance_check_counts
      WHERE check_run_id = (SELECT max(id) FROM teras_diagnostic_provenance_check_runs)),
    (SELECT count(*) FROM teras_diagnostic_provenance_check_counts count_snapshot
      WHERE NOT EXISTS (
        SELECT 1 FROM teras_diagnostic_provenance_check_runs run
        WHERE run.id = count_snapshot.check_run_id
      )),
    (SELECT count(*) FROM teras_diagnostic_provenance_exceptions)
")"
expected_first_retained_state="30|$(
  psql "$DATABASE_URL" -Atqc \
    "SELECT max(id) FROM teras_diagnostic_provenance_check_runs"
)|$exception_group_count|0|$exception_count_before_retention"
if [ "$first_retained_state" != "$expected_first_retained_state" ]; then
  echo "First retention cleanup produced unexpected state: $first_retained_state" >&2
  exit 1
fi

first_latest_run_id="$(
  psql "$DATABASE_URL" -Atqc \
    "SELECT max(id) FROM teras_diagnostic_provenance_check_runs"
)"
run_schema_check "$retention_second_output"
second_retained_state="$(psql "$DATABASE_URL" -Atqc "
  SELECT
    (SELECT count(*) FROM teras_diagnostic_provenance_check_runs),
    (SELECT count(*) FROM teras_diagnostic_provenance_check_runs WHERE id = $first_latest_run_id),
    (SELECT count(*) FROM teras_diagnostic_provenance_check_counts
      WHERE check_run_id = $first_latest_run_id),
    (SELECT count(*) FROM teras_diagnostic_provenance_check_counts count_snapshot
      WHERE NOT EXISTS (
        SELECT 1 FROM teras_diagnostic_provenance_check_runs run
        WHERE run.id = count_snapshot.check_run_id
      )),
    (SELECT count(*) FROM teras_diagnostic_provenance_exceptions)
")"
expected_second_retained_state="30|1|$exception_group_count|0|$exception_count_before_retention"
if [ "$second_retained_state" != "$expected_second_retained_state" ]; then
  echo "Repeated retention cleanup produced unexpected state: $second_retained_state" >&2
  exit 1
fi

last_exception_baseline_output="$(mktemp)"
last_exception_resolved_output="$(mktemp)"
trap 'rm -f "$check_sql" "$baseline_output" "$second_output" "$cancelled_output" "$post_cancel_output" "$parallel_a_output" "$parallel_b_output" "$decrease_output" "$retention_first_output" "$retention_second_output" "$last_exception_baseline_output" "$last_exception_resolved_output" "$lock_ready_file" "$cancel_lock_ready_file"; cleanup' EXIT

# Isolate one group so resolving its last exception leaves no current count row.
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 <<'SQL' >/dev/null
DELETE FROM teras_diagnostic_provenance_exceptions;
INSERT INTO teras_diagnostic_provenance_exceptions
  (entity_type, entity_id, profile_id, session_id, reason, details)
VALUES (
  'profile', 'last-exception', 'profile-last-exception', 'session-last-exception',
  'NO_VALID_RESPONSE_CHAIN', '{}'::jsonb
);
SQL

run_schema_check "$last_exception_baseline_output"
baseline_one_state="$(psql "$DATABASE_URL" -Atqc "
  SELECT
    (SELECT count(*) FROM teras_diagnostic_provenance_exceptions),
    (SELECT count(*) FROM teras_diagnostic_provenance_check_counts
     WHERE check_run_id = (SELECT max(id) FROM teras_diagnostic_provenance_check_runs)),
    (SELECT exception_count FROM teras_diagnostic_provenance_check_counts
     WHERE check_run_id = (SELECT max(id) FROM teras_diagnostic_provenance_check_runs)
       AND entity_type = 'profile' AND reason = 'NO_VALID_RESPONSE_CHAIN')
")"
if [ "$baseline_one_state" != "1|1|1" ]; then
  echo "Last-exception baseline did not record exactly one exception: $baseline_one_state" >&2
  exit 1
fi
assert_contains "$last_exception_baseline_output" \
  "TERAS_DIAGNOSTIC_PROVENANCE_EXCEPTIONS entity_type=profile reason=NO_VALID_RESPONSE_CHAIN count=1"

psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c "
  DELETE FROM teras_diagnostic_provenance_exceptions
  WHERE entity_type = 'profile' AND entity_id = 'last-exception'
    AND reason = 'NO_VALID_RESPONSE_CHAIN'
" >/dev/null
run_schema_check "$last_exception_resolved_output"
assert_contains "$last_exception_resolved_output" \
  "TERAS_DIAGNOSTIC_PROVENANCE_EXCEPTIONS total=0"
assert_contains "$last_exception_resolved_output" \
  "TERAS_DIAGNOSTIC_PROVENANCE_EXCEPTIONS entity_type=profile reason=NO_VALID_RESPONSE_CHAIN previous_count=1 current_count=0 delta=-1"
assert_no_increase_warning "$last_exception_resolved_output"
assert_output_is_aggregate_only "$last_exception_resolved_output"
resolved_state="$(psql "$DATABASE_URL" -Atqc "
  SELECT
    (SELECT count(*) FROM teras_diagnostic_provenance_exceptions),
    (SELECT count(*) FROM teras_diagnostic_provenance_check_counts
     WHERE check_run_id = (SELECT max(id) FROM teras_diagnostic_provenance_check_runs))
")"
if [ "$resolved_state" != "0|0" ]; then
  echo "Resolved exception left a current exception or count snapshot: $resolved_state" >&2
  exit 1
fi

echo "Diagnostic provenance upgrade migration passed"
