#!/bin/bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"
: "${DATABASE_URL:?DATABASE_URL must be set}"

schema="teras_solar_pv_baseline_test_$$"
cleanup() { psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c "DROP SCHEMA IF EXISTS \"$schema\" CASCADE" >/dev/null; }
trap cleanup EXIT

psql "$DATABASE_URL" -v ON_ERROR_STOP=1 <<SQL >/dev/null
CREATE SCHEMA "$schema";
CREATE TABLE "$schema".teras_programs (
  id text PRIMARY KEY, domain text NOT NULL, track text NOT NULL, name text NOT NULL,
  description text NOT NULL, status text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), created_by text NOT NULL DEFAULT 'test'
);
CREATE TABLE "$schema".teras_pathways (
  id text PRIMARY KEY, program_id text NOT NULL, name text NOT NULL, type text NOT NULL,
  purpose text NOT NULL, outcome text NOT NULL, status text NOT NULL DEFAULT 'Active',
  created_at timestamptz NOT NULL DEFAULT now(), created_by text NOT NULL DEFAULT 'test'
);
CREATE TABLE "$schema".teras_modules (
  id text PRIMARY KEY, program_id text NOT NULL, pathway_id text NOT NULL, sequence integer NOT NULL,
  code text NOT NULL, name text NOT NULL,
  capability text NOT NULL, evidence text NOT NULL,
  learning_outcomes text[] NOT NULL, theory text[] NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), created_by text NOT NULL DEFAULT 'test'
);
CREATE TABLE "$schema".teras_course_modules (
  id text PRIMARY KEY, module_id text NOT NULL, pathway_id text NOT NULL,
  status text NOT NULL DEFAULT 'PUBLISHED'
);
CREATE TABLE "$schema".teras_lessons (
  id text PRIMARY KEY, course_module_id text NOT NULL, status text NOT NULL DEFAULT 'PUBLISHED'
);
CREATE TABLE "$schema".teras_learning_activities (
  id text PRIMARY KEY, lesson_id text NOT NULL, status text NOT NULL DEFAULT 'PUBLISHED'
);
CREATE TABLE "$schema".teras_content_resources (
  id text PRIMARY KEY, activity_id text NOT NULL, status text NOT NULL DEFAULT 'PUBLISHED'
);
CREATE TABLE "$schema".teras_learning_outcomes (
  id text PRIMARY KEY, activity_id text NOT NULL, status text NOT NULL DEFAULT 'PUBLISHED'
);
INSERT INTO "$schema".teras_programs VALUES ('solar-pv-tech', 'Solar PV', 'Solar PV', 'Solar PV', 'Solar PV', 'Active');
INSERT INTO "$schema".teras_pathways VALUES
  ('path-a', 'solar-pv-tech', 'Path A', 'Capability', 'capability-development', 'Capability'),
  ('path-b', 'solar-pv-tech', 'Path B', 'Pre-Certification', 'pre-certification', 'Readiness');
INSERT INTO "$schema".teras_modules
SELECT 'm' || lpad(n::text, 2, '0'), 'solar-pv-tech', 'path-a', n, 'OLD', 'Old M' || n, 'old', 'E00',
       ARRAY['old'], ARRAY['old'] FROM generate_series(1, 10) n;
INSERT INTO "$schema".teras_modules
SELECT 'b' || lpad(n::text, 2, '0'), 'solar-pv-tech', 'path-b', n, 'B' || lpad(n::text, 2, '0'), 'Legacy B' || n,
       'legacy', 'E00', ARRAY['legacy'], ARRAY['legacy'] FROM generate_series(1, 8) n;
INSERT INTO "$schema".teras_course_modules VALUES
  ('course-module-m01-path-b', 'm01', 'path-b', 'PUBLISHED');
INSERT INTO "$schema".teras_lessons VALUES
  ('lesson-m01-path-b', 'course-module-m01-path-b', 'PUBLISHED');
INSERT INTO "$schema".teras_learning_activities VALUES
  ('activity-m01-path-b', 'lesson-m01-path-b', 'PUBLISHED');
INSERT INTO "$schema".teras_content_resources VALUES
  ('resource-m01-path-b', 'activity-m01-path-b', 'PUBLISHED');
INSERT INTO "$schema".teras_learning_outcomes VALUES
  ('outcome-m01-path-b', 'activity-m01-path-b', 'PUBLISHED');
SQL

export PGOPTIONS="-c search_path=$schema"
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f lib/db/migrations/0034_solar_pv_shared_learning_baseline.sql >/dev/null
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
  -c "ALTER TABLE teras_learning_baselines ADD COLUMN IF NOT EXISTS published_version_id text" >/dev/null
pnpm --filter @workspace/scripts run seed -- --baseline-only >/dev/null
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f lib/db/migrations/0034_solar_pv_shared_learning_baseline.sql >/dev/null

psql "$DATABASE_URL" -v ON_ERROR_STOP=1 <<'SQL' >/dev/null
DO $$
DECLARE
  path_a_count integer;
  path_b_count integer;
  retired_count integer;
  selected_m01 boolean;
  selected_b01 boolean;
  archived_legacy_hierarchy boolean;
BEGIN
  SELECT count(*) INTO path_a_count
    FROM teras_pathway_baseline_modules WHERE pathway_id = 'path-a';
  SELECT count(*) INTO path_b_count
    FROM teras_pathway_baseline_modules WHERE pathway_id = 'path-b';
  SELECT count(*) INTO retired_count
    FROM teras_legacy_module_mappings WHERE pathway_id = 'path-b' AND status = 'retired';
  SELECT EXISTS (
    SELECT 1 FROM teras_pathway_baseline_modules p
    JOIN teras_baseline_modules b ON b.id = p.baseline_module_id
    WHERE p.pathway_id = 'path-b' AND b.module_id = 'm01'
  ) INTO selected_m01;
  SELECT EXISTS (
    SELECT 1 FROM teras_pathway_baseline_modules p
    JOIN teras_baseline_modules b ON b.id = p.baseline_module_id
    WHERE p.pathway_id = 'path-b' AND b.module_id = 'b01'
  ) INTO selected_b01;
  SELECT
    link.status = 'ARCHIVED' AND lesson.status = 'ARCHIVED'
    AND activity.status = 'ARCHIVED' AND resource.status = 'ARCHIVED'
    AND outcome.status = 'ARCHIVED'
  INTO archived_legacy_hierarchy
  FROM teras_course_modules link
  JOIN teras_lessons lesson ON lesson.course_module_id = link.id
  JOIN teras_learning_activities activity ON activity.lesson_id = lesson.id
  JOIN teras_content_resources resource ON resource.activity_id = activity.id
  JOIN teras_learning_outcomes outcome ON outcome.activity_id = activity.id
  WHERE link.id = 'course-module-m01-path-b';
  IF path_a_count <> 10 OR path_b_count <> 10 OR retired_count <> 8
    OR NOT selected_m01 OR selected_b01 OR NOT archived_legacy_hierarchy THEN
    RAISE EXCEPTION 'Solar PV baseline selection invariant failed: %, %, %, %, %, %',
      path_a_count, path_b_count, retired_count, selected_m01, selected_b01,
      archived_legacy_hierarchy;
  END IF;
END $$;
SQL
echo "Solar PV baseline migration/helper integration passed"