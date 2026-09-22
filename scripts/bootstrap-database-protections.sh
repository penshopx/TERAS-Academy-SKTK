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
  "lib/db/migrations/0053_baseline_pathway_scope_projection.sql"
  "lib/db/migrations/0054_path_b_regulatory_competency_foundation.sql"
)

if ! push_output="$(pnpm --filter @workspace/db run push 2>&1)"; then
  printf '%s\n' "$push_output" >&2
  echo "Database schema push failed before protection migrations." >&2
  exit 1
fi
printf '%s\n' "$push_output"
# drizzle-kit 0.31 can print an interactive-prompt error yet exit successfully.
# Treat the emitted error as authoritative so post-merge never continues after
# a skipped schema change.
if grep -Eiq '(^|[[:space:]])error:' <<<"$push_output"; then
  echo "Database schema push reported an error before protection migrations." >&2
  exit 1
fi
for migration in "${protection_migrations[@]}"; do
  echo "Applying database protection migration: $migration"
  if ! psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$migration"; then
    echo "Database protection migration failed: $migration" >&2
    exit 1
  fi
done
