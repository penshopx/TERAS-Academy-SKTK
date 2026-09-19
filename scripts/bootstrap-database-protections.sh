#!/bin/bash
set -euo pipefail

# Drizzle does not represent PostgreSQL functions and triggers. This is the
# canonical inventory of migrations that install persistent database
# protections after a schema push.
readonly protection_migrations=(
  "lib/db/migrations/0032_learning_record_link_ownership.sql"
  "lib/db/migrations/0033_enrollment_event_context.sql"
  "lib/db/migrations/0038_learning_resource_progress_context.sql"
  "lib/db/migrations/0039_baseline_versioned_publishing.sql"
  "lib/db/migrations/0044_baseline_draft_cancellation.sql"
  "lib/db/migrations/0051_agent_run_ledger.sql"
)

pnpm --filter @workspace/db run push
for migration in "${protection_migrations[@]}"; do
  echo "Applying database protection migration: $migration"
  if ! psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$migration"; then
    echo "Database protection migration failed: $migration" >&2
    exit 1
  fi
done
