#!/bin/bash
set -euo pipefail

# Drizzle does not represent the ownership functions and triggers. Keep this
# post-push step shared by post-merge and the empty-schema integration test.
pnpm --filter @workspace/db run push
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
  -f lib/db/migrations/0032_learning_record_link_ownership.sql