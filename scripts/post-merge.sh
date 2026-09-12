#!/bin/bash
set -euo pipefail

if [ "${NODE_ENV:-}" = "production" ] || [ "${REPLIT_DEPLOYMENT:-}" = "1" ]; then
  echo "Refusing to run development database reconciliation against production." >&2
  exit 1
fi

exec 9>/tmp/teras-post-merge.lock
if ! flock -n 9; then
  echo "Another TERAS post-merge reconciliation is already running." >&2
  exit 1
fi

pnpm install --frozen-lockfile
if [ "$(psql "$DATABASE_URL" -Atqc "SELECT to_regclass('public.teras_people') IS NOT NULL")" = "t" ]; then
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/post-merge.sql
  # Rehearse additive identity migration on existing installations. Bootstrap
  # is deliberately not environment-driven; Supabase aal2 provisioning is an
  # explicit operator action.
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f lib/db/migrations/0005_admin_management.sql
  # Preserve existing learner progress while adding immutable course versions,
  # authoring audit history, and managed-resource upload claims.
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
    -f lib/db/migrations/0006_course_authoring_versions.sql
  # Add persisted remediation activity idempotency without rewriting history.
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
    -f lib/db/migrations/0007_remediation_activity_idempotency.sql
  # Rehearse the additive knowledge upgrade before Drizzle evaluates its
  # family-version uniqueness constraint on an existing installation.
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
    -f lib/db/migrations/0008_knowledge_articles.sql
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
    -f lib/db/migrations/0009_knowledge_article_family_version.sql
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
    -f lib/db/migrations/0010_seed_baseline_assistant_knowledge.sql
  # Preserve learner reading position when upgrading an existing installation.
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
    -f lib/db/migrations/0011_learning_resource_progress.sql
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
    -f lib/db/migrations/0012_super_admin_governance.sql
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
    -f lib/db/migrations/0013_supabase_external_identity.sql
  # Persist anonymous not-found chatbot topics before lifecycle tests use them.
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
    -f lib/db/migrations/0014_knowledge_not_found_topics.sql
  # Rehearse the reusable competency framework upgrade before Drizzle pushes
  # its normalized tables on existing installations.
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
    -f lib/db/migrations/0016_competency_frameworks.sql
  # Preserve diagnostic templates, sessions, and learner readiness projections
  # when upgrading an existing installation.
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
    -f lib/db/migrations/0017_diagnostic.sql
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
    -f lib/db/migrations/0018_auditable_readiness_rules.sql
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
    -f lib/db/migrations/0019_diagnostic_recommendation_follow_ups.sql
  # Reconcile legacy duplicate attempts before Drizzle creates the invariant.
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
    -f lib/db/migrations/0020_diagnostic_single_active_session.sql
  # Establish the referenced session-owner uniqueness before Drizzle evaluates
  # the diagnostic profile composite foreign key.
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
    -f lib/db/migrations/0021_diagnostic_profile_session_learner.sql
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
    -f lib/db/migrations/0022_readiness_history_indexes.sql
  # Reconcile legacy duplicate active readiness rules before Drizzle creates
  # the database-level single-active invariant.
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
    -f lib/db/migrations/0023_readiness_single_active_rule.sql
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
    -f lib/db/migrations/0024_diagnostic_audit_session_learner.sql
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
    -f lib/db/migrations/0025_diagnostic_follow_up_reminder_deliveries.sql
  # Reject legacy cross-owner LMS events and establish enrollment ownership
  # before Drizzle evaluates the composite foreign keys.
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
    -f lib/db/migrations/0027_lms_event_enrollment_learner.sql
  # Align implementation-domain, track, and pathway-purpose semantics without
  # replacing stable catalogue IDs or historical learner records.
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
    -f lib/db/migrations/0028_academy_pathway_semantics.sql
  # Store trainer-owned email delivery settings as append-only operational
  # revisions, separate from diagnostic and readiness evidence.
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
    -f lib/db/migrations/0029_trainer_reminder_preferences.sql
fi
if [ "$(psql "$DATABASE_URL" -Atqc "SELECT to_regclass('public.teras_content_resources') IS NOT NULL")" = "t" ]; then
  TERAS_MIGRATION_ACTOR=post-merge-upgrade \
    bash scripts/apply-resource-uri-upgrade.sh
else
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
    -f lib/db/migrations/0004_content_resource_uri_http_check.sql
fi
pnpm --filter @workspace/db run push
TERAS_MIGRATION_ACTOR=post-merge-upgrade \
  bash scripts/apply-resource-uri-upgrade.sh
# New databases receive their tables from Drizzle, while existing databases
# have already received this same safe sequence as preflight above.
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
  -f lib/db/migrations/0008_knowledge_articles.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
  -f lib/db/migrations/0009_knowledge_article_family_version.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
  -f lib/db/migrations/0010_seed_baseline_assistant_knowledge.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
  -f lib/db/migrations/0011_learning_resource_progress.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
  -f lib/db/migrations/0012_super_admin_governance.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
  -f lib/db/migrations/0013_supabase_external_identity.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
  -f lib/db/migrations/0014_knowledge_not_found_topics.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
  -f lib/db/migrations/0016_competency_frameworks.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
  -f lib/db/migrations/0017_diagnostic.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
  -f lib/db/migrations/0018_auditable_readiness_rules.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
  -f lib/db/migrations/0019_diagnostic_recommendation_follow_ups.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
  -f lib/db/migrations/0020_diagnostic_single_active_session.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
  -f lib/db/migrations/0021_diagnostic_profile_session_learner.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
  -f lib/db/migrations/0022_readiness_history_indexes.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
  -f lib/db/migrations/0023_readiness_single_active_rule.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
  -f lib/db/migrations/0024_diagnostic_audit_session_learner.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
  -f lib/db/migrations/0025_diagnostic_follow_up_reminder_deliveries.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
  -f lib/db/migrations/0027_lms_event_enrollment_learner.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
  -f lib/db/migrations/0028_academy_pathway_semantics.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
  -f lib/db/migrations/0029_trainer_reminder_preferences.sql
if [ "$(pnpm --silent --filter @workspace/scripts run demo:fixtures-enabled)" = "1" ]; then
  pnpm --filter @workspace/scripts run seed:demo
else
  echo "Skipping TERAS demo fixture seed; explicit safe demo fixture mode is not enabled."
fi
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/schema-check.sql
# API tests consume declaration output from composite workspace libraries.
# Refresh it after merged schema changes and before any API test starts.
pnpm run typecheck:libs
pnpm --filter @workspace/api-server run test:resource-uri
pnpm --filter @workspace/scripts run test:resource-uri-audit
pnpm --filter @workspace/scripts run test:resource-uri-upgrade
pnpm --filter @workspace/scripts run test:admin-management-upgrade
pnpm --filter @workspace/scripts run test:remediation-idempotency-upgrade
pnpm --filter @workspace/scripts run test:knowledge-upgrade
pnpm --filter @workspace/scripts run test:competency-framework-upgrade
pnpm --filter @workspace/scripts run test:readiness-single-active-upgrade
pnpm --filter @workspace/scripts run test:admin-management
pnpm --filter @workspace/scripts run test:deployment-hardening
pnpm --filter @workspace/scripts run test:safety
pnpm --filter @workspace/api-server run test:knowledge-safety
pnpm --filter @workspace/api-server run test:knowledge-lifecycle
pnpm --filter @workspace/api-server run test:pathway-isolation
pnpm --filter @workspace/api-server run test:safety-blockers
pnpm --filter @workspace/api-server run test:lms-event-ownership
pnpm --filter @workspace/api-server run test:admin-management
pnpm --filter @workspace/api-server run test:competency
pnpm --filter @workspace/api-server run test:course-authoring
pnpm run typecheck
