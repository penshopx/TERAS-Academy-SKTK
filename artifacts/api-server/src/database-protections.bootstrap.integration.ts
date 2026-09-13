import assert from "node:assert/strict";
import pg from "pg";

const { Client } = pg;
const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error("DATABASE_URL is required for the database protections bootstrap test");
}

const expectedFunctions = [
  "teras_enforce_causal_link_ownership",
  "teras_enforce_event_enrollment_context",
  "teras_enforce_resource_progress_context",
  "teras_guard_enrollment_context_identity",
  "teras_guard_enrollment_pathway_history",
  "teras_preserve_causal_parent_ownership",
  "teras_reject_baseline_audit_mutation",
  "teras_reject_baseline_version_mutation",
  "teras_validate_baseline_published_pointer",
];

const expectedTriggers = [
  "teras_activity_completion_enrollment_context_guard",
  "teras_assessment_attempts_learner_ownership_trigger",
  "teras_baseline_audit_append_only",
  "teras_baseline_published_pointer_guard",
  "teras_baseline_version_immutable",
  "teras_enrollment_context_identity_guard",
  "teras_enrollment_pathway_history_guard",
  "teras_evidence_learner_ownership_trigger",
  "teras_evidence_reviews_evidence_ownership_trigger",
  "teras_gaps_learner_ownership_trigger",
  "teras_learning_record_links_learner_ownership_trigger",
  "teras_learning_resource_progress_context_guard",
  "teras_learning_transition_enrollment_context_guard",
  "teras_outcome_verification_enrollment_context_guard",
  "teras_practice_attempts_learner_ownership_trigger",
  "teras_readiness_events_enrollment_context_guard",
  "teras_readiness_transfer_enrollment_context_guard",
  "teras_reassessment_links_learner_ownership_trigger",
  "teras_remediation_plans_gap_ownership_trigger",
];

const client = new Client({ connectionString: databaseUrl });
await client.connect();
try {
  const functions = await client.query<{ name: string }>(`
    SELECT p.proname AS name
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = current_schema()
      AND p.proname = ANY($1::text[])
    ORDER BY p.proname
  `, [expectedFunctions]);
  assert.deepEqual(
    functions.rows.map(row => row.name),
    expectedFunctions,
    "empty-database bootstrap must install every persistent protection function",
  );

  const triggers = await client.query<{ name: string }>(`
    SELECT DISTINCT trigger_name AS name
    FROM information_schema.triggers
    WHERE trigger_schema = current_schema()
      AND trigger_name = ANY($1::text[])
    ORDER BY trigger_name
  `, [expectedTriggers]);
  assert.deepEqual(
    triggers.rows.map(row => row.name),
    expectedTriggers,
    "empty-database bootstrap must install every persistent protection trigger",
  );
} finally {
  await client.end();
}