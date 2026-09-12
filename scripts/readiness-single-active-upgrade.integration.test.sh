#!/bin/bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

: "${DATABASE_URL:?DATABASE_URL must be set}"

schema="teras_readiness_single_active_upgrade_test_$$"
cleanup() {
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
    -c "DROP SCHEMA IF EXISTS \"$schema\" CASCADE" >/dev/null
}
trap cleanup EXIT

psql "$DATABASE_URL" -v ON_ERROR_STOP=1 <<SQL >/dev/null
CREATE SCHEMA "$schema";
CREATE TABLE "$schema".teras_readiness_gates (
  id text PRIMARY KEY,
  pathway_id text NOT NULL,
  code text NOT NULL,
  rule_version integer NOT NULL,
  active boolean NOT NULL,
  created_at timestamptz NOT NULL
);

INSERT INTO "$schema".teras_readiness_gates
  (id, pathway_id, code, rule_version, active, created_at)
VALUES
  ('rule-v1', 'path-a', 'SAFETY', 1, true, '2026-01-01T00:00:00Z'),
  ('rule-v2', 'path-a', 'SAFETY', 2, true, '2026-02-01T00:00:00Z'),
  ('rule-v3', 'path-a', 'SAFETY', 3, true, '2026-03-01T00:00:00Z'),
  ('other-code', 'path-a', 'QUALITY', 1, true, '2026-01-01T00:00:00Z'),
  ('other-path', 'path-b', 'SAFETY', 1, true, '2026-01-01T00:00:00Z'),
  ('created-earlier', 'path-created-at', 'SAFETY', 7, true, '2026-04-01T00:00:00Z'),
  ('created-later', 'path-created-at', 'SAFETY', 7, true, '2026-05-01T00:00:00Z'),
  ('id-a', 'path-id', 'SAFETY', 9, true, '2026-06-01T00:00:00Z'),
  ('id-z', 'path-id', 'SAFETY', 9, true, '2026-06-01T00:00:00Z');
SQL

export PGOPTIONS="-c search_path=$schema"
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
  -f lib/db/migrations/0023_readiness_single_active_rule.sql >/dev/null
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
  -f lib/db/migrations/0023_readiness_single_active_rule.sql >/dev/null

state="$(psql "$DATABASE_URL" -Atqc "
  SELECT
    count(*) FILTER (WHERE pathway_id = 'path-a' AND code = 'SAFETY' AND active),
    count(*) FILTER (WHERE pathway_id = 'path-a' AND code = 'SAFETY' AND active AND rule_version = 3),
    count(*) FILTER (WHERE pathway_id = 'path-a' AND code = 'SAFETY' AND NOT active),
    count(*) FILTER (WHERE id IN ('other-code', 'other-path') AND active),
    count(*) FILTER (WHERE pathway_id = 'path-created-at' AND code = 'SAFETY' AND active),
    count(*) FILTER (WHERE id = 'created-later' AND active),
    count(*) FILTER (WHERE id = 'created-earlier' AND NOT active),
    count(*) FILTER (WHERE pathway_id = 'path-id' AND code = 'SAFETY' AND active),
    count(*) FILTER (WHERE id = 'id-z' AND active),
    count(*) FILTER (WHERE id = 'id-a' AND NOT active)
  FROM teras_readiness_gates
")"
if [ "$state" != "1|1|2|2|1|1|1|1|1|1" ]; then
  echo "Readiness migration did not preserve the expected active rule by version, creation time, and ID: $state" >&2
  exit 1
fi

if psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c "
  INSERT INTO teras_readiness_gates
    (id, pathway_id, code, rule_version, active, created_at)
  VALUES
    ('rule-v4', 'path-a', 'SAFETY', 4, true, '2026-04-01T00:00:00Z')
" >/dev/null 2>&1; then
  echo "Readiness single-active uniqueness was not enforced" >&2
  exit 1
fi

echo "Readiness single-active upgrade migration passed"