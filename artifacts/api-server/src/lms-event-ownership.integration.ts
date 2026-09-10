import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import pg from "pg";

const { Client } = pg;
const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error("DATABASE_URL is required for the LMS event ownership integration test");
}

const migration = await readFile(
  new URL("../../../lib/db/migrations/0027_lms_event_enrollment_learner.sql", import.meta.url),
  "utf8",
);
const client = new Client({ connectionString: databaseUrl });

async function assertOwnershipRejected(sql: string, values: unknown[], constraint: string) {
  await assert.rejects(
    client.query(sql, values),
    (error: unknown) => {
      if (!(error instanceof Error)) return false;
      const databaseError = error as Error & { code?: string; constraint?: string };
      return databaseError.code === "23503" && databaseError.constraint === constraint;
    },
    `Expected ${constraint} to reject a learner from another enrollment`,
  );
}

await client.connect();
try {
  await client.query(`
    INSERT INTO teras_enrollments
      (id, learner_id, program_id, pathway_id, status)
    VALUES
      ('ownership-enrollment-a', 'ownership-learner-a', 'ownership-program', 'ownership-pathway', 'active'),
      ('ownership-enrollment-b', 'ownership-learner-b', 'ownership-program', 'ownership-pathway', 'active')
  `);

  await client.query(`
    INSERT INTO teras_activity_completion_events
      (id, activity_id, learner_id, enrollment_id, pathway_id, status, actor_id)
    VALUES
      ('ownership-legacy-mismatch', 'ownership-activity', 'ownership-learner-b',
       'ownership-enrollment-a', 'ownership-pathway', 'completed', 'ownership-actor')
  `);

  await assert.rejects(
    client.query(migration),
    /Cannot enforce LMS event ownership: learner differs from enrollment owner in teras_activity_completion_events/,
  );
  await client.query("ROLLBACK");

  await client.query(
    "DELETE FROM teras_activity_completion_events WHERE id = 'ownership-legacy-mismatch'",
  );
  await client.query(migration);
  await client.query(migration);

  await client.query(`
    INSERT INTO teras_activity_completion_events
      (id, activity_id, learner_id, enrollment_id, pathway_id, status, actor_id)
    VALUES
      ('ownership-activity-valid', 'ownership-activity', 'ownership-learner-a',
       'ownership-enrollment-a', 'ownership-pathway', 'completed', 'ownership-actor')
  `);
  await assertOwnershipRejected(
    `INSERT INTO teras_activity_completion_events
      (id, activity_id, learner_id, enrollment_id, pathway_id, status, actor_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      "ownership-activity-invalid",
      "ownership-activity",
      "ownership-learner-b",
      "ownership-enrollment-a",
      "ownership-pathway",
      "completed",
      "ownership-actor",
    ],
    "teras_activity_completion_enrollment_learner_fk",
  );

  await client.query(`
    INSERT INTO teras_outcome_verification_events
      (id, outcome_id, activity_id, learner_id, enrollment_id, pathway_id,
       verifier_id, result, reason)
    VALUES
      ('ownership-outcome-valid', 'ownership-outcome', 'ownership-activity',
       'ownership-learner-a', 'ownership-enrollment-a', 'ownership-pathway',
       'ownership-verifier', 'verified', 'valid ownership')
  `);
  await assertOwnershipRejected(
    `INSERT INTO teras_outcome_verification_events
      (id, outcome_id, activity_id, learner_id, enrollment_id, pathway_id,
       verifier_id, result, reason)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      "ownership-outcome-invalid",
      "ownership-outcome",
      "ownership-activity",
      "ownership-learner-b",
      "ownership-enrollment-a",
      "ownership-pathway",
      "ownership-verifier",
      "verified",
      "cross-owner",
    ],
    "teras_outcome_verification_enrollment_learner_fk",
  );

  await client.query(`
    INSERT INTO teras_readiness_transfer_events
      (id, learner_id, enrollment_id, program_id, pathway_id, source_context, triggered_by)
    VALUES
      ('ownership-readiness-valid', 'ownership-learner-a', 'ownership-enrollment-a',
       'ownership-program', 'ownership-pathway', '{}'::jsonb, 'ownership-actor')
  `);
  await assertOwnershipRejected(
    `INSERT INTO teras_readiness_transfer_events
      (id, learner_id, enrollment_id, program_id, pathway_id, source_context, triggered_by)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
    [
      "ownership-readiness-invalid",
      "ownership-learner-b",
      "ownership-enrollment-a",
      "ownership-program",
      "ownership-pathway",
      "{}",
      "ownership-actor",
    ],
    "teras_readiness_transfer_enrollment_learner_fk",
  );

  await client.query(`
    INSERT INTO teras_learning_transition_events
      (id, activity_id, learner_id, enrollment_id, program_id, pathway_id,
       from_state, to_state, actor_id, actor_role, entity_reference, reason, idempotency_key)
    VALUES
      ('ownership-transition-valid', 'ownership-activity', 'ownership-learner-a',
       'ownership-enrollment-a', 'ownership-program', 'ownership-pathway',
       'assigned', 'started', 'ownership-actor', 'learner', 'ownership-activity',
       'valid ownership', 'ownership-transition-valid')
  `);
  await assertOwnershipRejected(
    `INSERT INTO teras_learning_transition_events
      (id, activity_id, learner_id, enrollment_id, program_id, pathway_id,
       from_state, to_state, actor_id, actor_role, entity_reference, reason, idempotency_key)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
    [
      "ownership-transition-invalid",
      "ownership-activity",
      "ownership-learner-b",
      "ownership-enrollment-a",
      "ownership-program",
      "ownership-pathway",
      "assigned",
      "started",
      "ownership-actor",
      "learner",
      "ownership-activity",
      "cross-owner",
      "ownership-transition-invalid",
    ],
    "teras_learning_transition_enrollment_learner_fk",
  );

  console.info("LMS event ownership integration test passed");
} finally {
  await client.end();
}