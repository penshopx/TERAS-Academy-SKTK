#!/bin/bash
set -euo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"
: "${DATABASE_URL:?DATABASE_URL must be set}"
schema="teras_competency_upgrade_test_$$"
cleanup() { psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c "DROP SCHEMA IF EXISTS \"$schema\" CASCADE" >/dev/null; }
trap cleanup EXIT
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 <<SQL >/dev/null
CREATE SCHEMA "$schema";
CREATE TABLE "$schema".teras_pathways (id text PRIMARY KEY, program_id text NOT NULL, name text NOT NULL, type text NOT NULL, outcome text NOT NULL);
CREATE TABLE "$schema".teras_modules (id text PRIMARY KEY);
CREATE TABLE "$schema".teras_practice_tasks (id text PRIMARY KEY, module_id text NOT NULL);
CREATE TABLE "$schema".teras_evidence_requirements (id text PRIMARY KEY, module_id text NOT NULL);
CREATE TABLE "$schema".teras_learning_activities (id text PRIMARY KEY);
CREATE TABLE "$schema".teras_learning_outcomes (id text PRIMARY KEY, activity_id text NOT NULL, description text NOT NULL, verification_method text NOT NULL);
INSERT INTO "$schema".teras_pathways VALUES ('path-a', 'program', 'Path A', 'Primary', 'Install');
INSERT INTO "$schema".teras_practice_tasks VALUES ('task-m03', 'm03');
INSERT INTO "$schema".teras_evidence_requirements VALUES ('req-m03', 'm03');
INSERT INTO "$schema".teras_learning_outcomes VALUES ('outcome-m03-sequence', 'activity-m03', 'Safe isolation', 'TRAINER_REVIEW');
SQL
export PGOPTIONS="-c search_path=$schema"
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f lib/db/migrations/0016_competency_frameworks.sql >/dev/null
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f lib/db/migrations/0016_competency_frameworks.sql >/dev/null
state="$(psql "$DATABASE_URL" -Atqc "SELECT count(*) FROM information_schema.tables WHERE table_schema = '$schema' AND table_name IN ('teras_competency_frameworks','teras_competency_units','teras_pathway_competency_units','teras_competency_unit_outcomes','teras_competency_unit_practice_tasks','teras_competency_unit_evidence_requirements','teras_competency_unit_simulations','teras_competency_unit_safety_rules')")"
[ "$state" = "8" ] || { echo "Competency migration did not create all tables: $state" >&2; exit 1; }
fk_count="$(psql "$DATABASE_URL" -Atqc "SELECT count(*) FROM information_schema.table_constraints WHERE constraint_schema = '$schema' AND constraint_type = 'FOREIGN KEY' AND table_name LIKE 'teras_competency%'")"
[ "$fk_count" -ge 9 ] || { echo "Competency migration is missing expected foreign keys: $fk_count" >&2; exit 1; }
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c "INSERT INTO teras_competency_frameworks (id,code,name,description) VALUES ('framework','TEST','Test','Test'); INSERT INTO teras_competency_units (id,framework_id,code,title,description) VALUES ('unit','framework','U1','Unit','Unit'); INSERT INTO teras_competency_unit_outcomes (id,unit_id,learning_outcome_id,outcome_code,description,verification_method) VALUES ('outcome','unit','outcome-m03-sequence','LO1','Safe','TRAINER_REVIEW');" >/dev/null
echo "Competency framework migration upgrade passed"