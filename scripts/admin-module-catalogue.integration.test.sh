#!/bin/bash
set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/cleanup-diagnostics.sh"

: "${DATABASE_URL:?DATABASE_URL must be set}"

test_database="teras_module_catalogue_${RANDOM}_$$"
cleanup() {
  local test_exit=$?
  local cleanup_exit=0
  local cleanup_output=""
  trap - EXIT

  if cleanup_output="$(dropdb --maintenance-db="$DATABASE_URL" --if-exists "$test_database" 2>&1)"; then
    :
  else
    cleanup_exit=$?
    report_cleanup_failure "dropdb" "$cleanup_exit" "$cleanup_output"
  fi

  if (( test_exit != 0 )); then
    exit "$test_exit"
  fi
  exit "$cleanup_exit"
}
trap cleanup EXIT

createdb --maintenance-db="$DATABASE_URL" "$test_database"
test_database_url="$(node -e '
  const url = new URL(process.env.DATABASE_URL);
  url.pathname = "/" + process.argv[1];
  process.stdout.write(url.toString());
' "$test_database")"

psql "$test_database_url" -v ON_ERROR_STOP=1 <<'SQL' >/dev/null
CREATE FUNCTION teras_is_valid_resource_uri(value text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT value ~ '^https?://[^[:space:]]+$'
     AND value !~ '[<>"{}|\\^`]'
$$;
SQL

if ! push_output="$(DATABASE_URL="$test_database_url" pnpm --filter @workspace/db run push-force 2>&1)"; then
  printf '%s\n' "$push_output" >&2
  exit 1
fi
if printf '%s\n' "$push_output" | grep -Eiq '(^|[[:space:]])error:'; then
  printf '%s\n' "$push_output" >&2
  exit 1
fi

psql "$test_database_url" -v ON_ERROR_STOP=1 <<'SQL' >/dev/null
INSERT INTO teras_programs (id, domain, name, description, status)
VALUES ('program', 'test', 'Test Program', 'Test', 'active');
INSERT INTO teras_pathways (id, program_id, name, type, outcome)
VALUES ('path', 'program', 'Test Path', 'primary', 'Test');
INSERT INTO teras_learning_baselines (id, code, name, description)
VALUES ('baseline', 'BASE', 'Baseline', 'Test');
INSERT INTO teras_modules
  (id, program_id, pathway_id, sequence, code, name, capability, evidence, learning_outcomes, theory)
VALUES
  ('m01', 'program', 'path', 1, 'M01', 'Canonical module row', 'Test', 'Test', ARRAY['Test'], ARRAY['Test']),
  ('b01', 'program', 'path', 11, 'B01', 'Legacy 1', 'Test', 'Test', ARRAY['Test'], ARRAY['Test']),
  ('b02', 'program', 'path', 12, 'B02', 'Legacy 2', 'Test', 'Test', ARRAY['Test'], ARRAY['Test']),
  ('b03', 'program', 'path', 13, 'B03', 'Legacy 3', 'Test', 'Test', ARRAY['Test'], ARRAY['Test']),
  ('b04', 'program', 'path', 14, 'B04', 'Legacy 4', 'Test', 'Test', ARRAY['Test'], ARRAY['Test']);
INSERT INTO teras_baseline_modules
  (id, baseline_id, module_id, sequence, code, name, learning_outcome, evidence_id)
VALUES ('canonical-1', 'baseline', 'm01', 1, 'M01', 'Canonical 1', 'Test', 'evidence-1');
INSERT INTO teras_legacy_module_mappings
  (id, legacy_module_id, baseline_module_id, pathway_id, note)
VALUES ('mapped', 'b01', 'canonical-1', 'path', 'Valid mapping');

ALTER TABLE teras_legacy_module_mappings
  DROP CONSTRAINT teras_legacy_module_mappings_baseline_module_id_teras_baseline_modules_id_fk;
DROP INDEX teras_legacy_module_mappings_legacy_unique;
INSERT INTO teras_legacy_module_mappings
  (id, legacy_module_id, baseline_module_id, pathway_id, note)
VALUES
  ('orphaned', 'b03', 'deleted-target', 'path', 'Orphaned target'),
  ('duplicate-a', 'b04', 'canonical-1', 'path', 'First duplicate'),
  ('duplicate-b', 'b04', 'deleted-target', 'path', 'Second duplicate');
SQL

DATABASE_URL="$test_database_url" NODE_ENV=test \
  pnpm --filter @workspace/api-server exec tsx ./src/admin-module-catalogue.integration.ts