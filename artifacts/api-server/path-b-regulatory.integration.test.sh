#!/bin/bash
set -euo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo_root"
: "${DATABASE_URL:?DATABASE_URL must be set}"
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f lib/db/migrations/0054_path_b_regulatory_competency_foundation.sql >/dev/null
NODE_ENV=test pnpm --filter @workspace/api-server exec tsx ./src/regulatory-references.integration.ts