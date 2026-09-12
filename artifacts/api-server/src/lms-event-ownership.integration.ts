import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import pg from "pg";

const { Client } = pg;
const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error("DATABASE_URL is required for the LMS event ownership integration test");
}

const ownershipMigration = await readFile(
  new URL("../../../lib/db/migrations/0027_lms_event_enrollment_learner.sql", import.meta.url),
  "utf8",
);
const contextMigration = await readFile(
  new URL("../../../lib/db/migrations/0033_enrollment_event_context.sql", import.meta.url),
  "utf8",
);
const client = new Client({ connectionString: databaseUrl });
const pathwayClient = new Client({
  connectionString: databaseUrl,
  application_name: "lms-event-ownership-pathway-race",
});
const eventClient = new Client({
  connectionString: databaseUrl,
  application_name: "lms-event-ownership-event-race",
});

async function waitForEnrollmentLockWait() {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const waiting = await client.query<{ waiting: boolean }>(`
      SELECT EXISTS (
        SELECT 1
        FROM pg_stat_activity
        WHERE application_name = 'lms-event-ownership-event-race'
          AND wait_event_type = 'Lock'
      ) AS waiting
    `);
    if (waiting.rows[0]?.waiting) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.fail("event transaction did not wait for the enrollment row lock");
}

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

async function assertContextRejected(sql: string, values: unknown[], constraint: string) {
  await assert.rejects(
    client.query(sql, values),
    (error: unknown) => {
      if (!(error instanceof Error)) return false;
      const databaseError = error as Error & { code?: string; constraint?: string };
      return databaseError.code === "23503" && databaseError.constraint === constraint;
    },
    `Expected ${constraint} to reject cross-context data`,
  );
}

async function assertHistoryRejected(sql: string, values: unknown[], constraint: string) {
  await assert.rejects(
    client.query(sql, values),
    (error: unknown) => {
      if (!(error instanceof Error)) return false;
      const databaseError = error as Error & { code?: string; constraint?: string };
      return databaseError.code === "23514" && databaseError.constraint === constraint;
    },
    `Expected ${constraint} to protect append-only pathway history`,
  );
}

await Promise.all([client.connect(), pathwayClient.connect(), eventClient.connect()]);
try {
  await client.query(`
    INSERT INTO teras_enrollments
      (id, learner_id, program_id, pathway_id, status)
    VALUES
      ('ownership-enrollment-a', 'ownership-learner-a', 'ownership-program-a', 'ownership-pathway-a', 'active'),
      ('ownership-enrollment-b', 'ownership-learner-b', 'ownership-program-b', 'ownership-pathway-b', 'active')
  `);
  await client.query(`
    INSERT INTO teras_learning_activities
      (id, lesson_id, program_id, pathway_id, type, title, description, sequence)
    VALUES
      ('ownership-activity-a', 'ownership-lesson-a', 'ownership-program-a', 'ownership-pathway-a',
       'lesson', 'Activity A', 'Context A', 1),
      ('ownership-activity-b', 'ownership-lesson-b', 'ownership-program-b', 'ownership-pathway-b',
       'lesson', 'Activity B', 'Context B', 1),
      ('ownership-activity-a-switch', 'ownership-lesson-a-switch', 'ownership-program-a', 'ownership-pathway-a-switch',
       'lesson', 'Activity A switch', 'Second pathway in program A', 1),
      ('ownership-activity-b-switch', 'ownership-lesson-b-switch', 'ownership-program-b', 'ownership-pathway-b-switch',
       'lesson', 'Activity B switch', 'Second pathway in program B', 1)
  `);
  await client.query(`
    INSERT INTO teras_learning_outcomes
      (id, activity_id, description, verification_method, sequence)
    VALUES
      ('ownership-outcome-a', 'ownership-activity-a', 'Outcome A', 'review', 1),
      ('ownership-outcome-b', 'ownership-activity-b', 'Outcome B', 'review', 1)
  `);
  await client.query(`
    INSERT INTO teras_readiness_gates
      (id, program_id, pathway_id, sequence, code, name, requirement)
    VALUES
      ('ownership-gate-a', 'ownership-program-a', 'ownership-pathway-a', 1, 'G-A', 'Gate A', 'Requirement A'),
      ('ownership-gate-b', 'ownership-program-b', 'ownership-pathway-b', 1, 'G-B', 'Gate B', 'Requirement B')
  `);

  await client.query(`
    INSERT INTO teras_activity_completion_events
      (id, activity_id, learner_id, enrollment_id, pathway_id, status, actor_id)
    VALUES
      ('ownership-legacy-mismatch', 'ownership-activity-a', 'ownership-learner-b',
       'ownership-enrollment-a', 'ownership-pathway-a', 'completed', 'ownership-actor')
  `);

  await assert.rejects(
    client.query(ownershipMigration),
    /Cannot enforce LMS event ownership: learner differs from enrollment owner in teras_activity_completion_events/,
  );
  await client.query("ROLLBACK");

  await client.query(
    "DELETE FROM teras_activity_completion_events WHERE id = 'ownership-legacy-mismatch'",
  );
  await client.query(ownershipMigration);
  await client.query(ownershipMigration);

  await client.query(`
    INSERT INTO teras_activity_completion_events
      (id, activity_id, learner_id, enrollment_id, pathway_id, status, actor_id)
    VALUES
      ('context-legacy-mismatch', 'ownership-activity-b', 'ownership-learner-a',
       'ownership-enrollment-a', 'ownership-pathway-b', 'completed', 'ownership-actor')
  `);
  await assert.rejects(
    client.query(contextMigration),
    /Cannot enforce enrollment event context: program or pathway mismatch in teras_activity_completion_events/,
  );
  await client.query("ROLLBACK");
  await client.query("DELETE FROM teras_activity_completion_events WHERE id = 'context-legacy-mismatch'");
  await client.query(contextMigration);
  await client.query(contextMigration);

  await client.query(`
    INSERT INTO teras_activity_completion_events
      (id, activity_id, learner_id, enrollment_id, pathway_id, status, actor_id)
    VALUES
      ('ownership-activity-valid', 'ownership-activity-a', 'ownership-learner-a',
       'ownership-enrollment-a', 'ownership-pathway-a', 'completed', 'ownership-actor')
  `);
  await assertOwnershipRejected(
    `INSERT INTO teras_activity_completion_events
      (id, activity_id, learner_id, enrollment_id, pathway_id, status, actor_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      "ownership-activity-invalid",
      "ownership-activity-a",
      "ownership-learner-b",
      "ownership-enrollment-a",
      "ownership-pathway-a",
      "completed",
      "ownership-actor",
    ],
    "teras_activity_completion_enrollment_learner_fk",
  );
  await assertContextRejected(
    `INSERT INTO teras_activity_completion_events
      (id, activity_id, learner_id, enrollment_id, pathway_id, status, actor_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    ["context-completion-cross-enrollment", "ownership-activity-b", "ownership-learner-a",
      "ownership-enrollment-a", "ownership-pathway-b", "completed", "ownership-actor"],
    "teras_activity_completion_enrollment_context_guard",
  );
  await assertContextRejected(
    `INSERT INTO teras_activity_completion_events
      (id, activity_id, learner_id, enrollment_id, pathway_id, status, actor_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    ["context-completion-cross-activity", "ownership-activity-b", "ownership-learner-a",
      "ownership-enrollment-a", "ownership-pathway-a", "completed", "ownership-actor"],
    "teras_activity_completion_activity_pathway_fk",
  );

  await client.query(`
    INSERT INTO teras_outcome_verification_events
      (id, outcome_id, activity_id, learner_id, enrollment_id, pathway_id,
       verifier_id, result, reason)
    VALUES
      ('ownership-outcome-valid', 'ownership-outcome-a', 'ownership-activity-a',
       'ownership-learner-a', 'ownership-enrollment-a', 'ownership-pathway-a',
       'ownership-verifier', 'verified', 'valid ownership')
  `);
  await assertOwnershipRejected(
    `INSERT INTO teras_outcome_verification_events
      (id, outcome_id, activity_id, learner_id, enrollment_id, pathway_id,
       verifier_id, result, reason)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      "ownership-outcome-invalid",
      "ownership-outcome-a",
      "ownership-activity-a",
      "ownership-learner-b",
      "ownership-enrollment-a",
      "ownership-pathway-a",
      "ownership-verifier",
      "verified",
      "cross-owner",
    ],
    "teras_outcome_verification_enrollment_learner_fk",
  );
  await assertContextRejected(
    `INSERT INTO teras_outcome_verification_events
      (id, outcome_id, activity_id, learner_id, enrollment_id, pathway_id,
       verifier_id, result, reason)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    ["context-outcome-cross-activity", "ownership-outcome-a", "ownership-activity-b",
      "ownership-learner-b", "ownership-enrollment-b", "ownership-pathway-b",
      "ownership-verifier", "verified", "cross activity"],
    "teras_outcome_verification_outcome_activity_fk",
  );
  await assertContextRejected(
    `INSERT INTO teras_outcome_verification_events
      (id, outcome_id, activity_id, learner_id, enrollment_id, pathway_id,
       verifier_id, result, reason)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    ["context-outcome-cross-enrollment", "ownership-outcome-b", "ownership-activity-b",
      "ownership-learner-a", "ownership-enrollment-a", "ownership-pathway-b",
      "ownership-verifier", "verified", "cross enrollment"],
    "teras_outcome_verification_enrollment_context_guard",
  );

  await client.query(`
    INSERT INTO teras_readiness_transfer_events
      (id, learner_id, enrollment_id, program_id, pathway_id, source_context, triggered_by)
    VALUES
      ('ownership-readiness-valid', 'ownership-learner-a', 'ownership-enrollment-a',
       'ownership-program-a', 'ownership-pathway-a', '{}'::jsonb, 'ownership-actor')
  `);
  await assertOwnershipRejected(
    `INSERT INTO teras_readiness_transfer_events
      (id, learner_id, enrollment_id, program_id, pathway_id, source_context, triggered_by)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
    [
      "ownership-readiness-invalid",
      "ownership-learner-b",
      "ownership-enrollment-a",
      "ownership-program-a",
      "ownership-pathway-a",
      "{}",
      "ownership-actor",
    ],
    "teras_readiness_transfer_enrollment_learner_fk",
  );
  await assertContextRejected(
    `INSERT INTO teras_readiness_transfer_events
      (id, learner_id, enrollment_id, program_id, pathway_id, source_context, triggered_by)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
    ["context-transfer-cross-program", "ownership-learner-a", "ownership-enrollment-a",
      "ownership-program-b", "ownership-pathway-b", "{}", "ownership-actor"],
    "teras_readiness_transfer_enrollment_context_guard",
  );

  await client.query(`
    INSERT INTO teras_learning_transition_events
      (id, activity_id, learner_id, enrollment_id, program_id, pathway_id,
       from_state, to_state, actor_id, actor_role, entity_reference, reason, idempotency_key)
    VALUES
      ('ownership-transition-valid', 'ownership-activity-a', 'ownership-learner-a',
       'ownership-enrollment-a', 'ownership-program-a', 'ownership-pathway-a',
       'assigned', 'started', 'ownership-actor', 'learner', 'ownership-activity-a',
       'valid ownership', 'ownership-transition-valid')
  `);
  await assertOwnershipRejected(
    `INSERT INTO teras_learning_transition_events
      (id, activity_id, learner_id, enrollment_id, program_id, pathway_id,
       from_state, to_state, actor_id, actor_role, entity_reference, reason, idempotency_key)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
    [
      "ownership-transition-invalid",
      "ownership-activity-a",
      "ownership-learner-b",
      "ownership-enrollment-a",
      "ownership-program-a",
      "ownership-pathway-a",
      "assigned",
      "started",
      "ownership-actor",
      "learner",
      "ownership-activity-a",
      "cross-owner",
      "ownership-transition-invalid",
    ],
    "teras_learning_transition_enrollment_learner_fk",
  );
  await assertContextRejected(
    `INSERT INTO teras_learning_transition_events
      (id, activity_id, learner_id, enrollment_id, program_id, pathway_id,
       from_state, to_state, actor_id, actor_role, entity_reference, reason, idempotency_key)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
    ["context-transition-cross-activity", "ownership-activity-b", "ownership-learner-a",
      "ownership-enrollment-a", "ownership-program-a", "ownership-pathway-a",
      "assigned", "started", "ownership-actor", "learner", "ownership-activity-b",
      "cross activity", "context-transition-cross-activity"],
    "teras_learning_transition_activity_context_fk",
  );

  await client.query(`
    INSERT INTO teras_readiness_events
      (id, enrollment_id, pathway_id, gate_id, status, score)
    VALUES
      ('ownership-readiness-event-valid', 'ownership-enrollment-a', 'ownership-pathway-a',
       'ownership-gate-a', 'Developing', 50)
  `);
  await assertContextRejected(
    `INSERT INTO teras_readiness_events
      (id, enrollment_id, pathway_id, gate_id, status, score)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    ["context-readiness-cross-gate", "ownership-enrollment-a", "ownership-pathway-a",
      "ownership-gate-b", "Developing", 50],
    "teras_readiness_events_gate_pathway_fk",
  );

  await client.query(`
    INSERT INTO teras_enrollment_pathway_events
      (id, enrollment_id, pathway_id, program_id, sequence)
    VALUES
      ('ownership-pathway-selection-b', 'ownership-enrollment-a',
       'ownership-pathway-a-switch', 'ownership-program-a', 1)
  `);
  await client.query(`
    INSERT INTO teras_activity_completion_events
      (id, activity_id, learner_id, enrollment_id, pathway_id, status, actor_id)
    VALUES
      ('context-after-pathway-selection', 'ownership-activity-a-switch', 'ownership-learner-a',
       'ownership-enrollment-a', 'ownership-pathway-a-switch', 'completed', 'ownership-actor')
  `);
  const preserved = await client.query(
    `SELECT id FROM teras_activity_completion_events
     WHERE id IN ('ownership-activity-valid', 'context-after-pathway-selection')
     ORDER BY id`,
  );
  assert.deepEqual(
    preserved.rows.map(row => row.id),
    ["context-after-pathway-selection", "ownership-activity-valid"],
    "a later pathway selection accepts new context without invalidating prior history",
  );
  await client.query(contextMigration);
  await assertHistoryRejected(
    `UPDATE teras_enrollment_pathway_events SET pathway_id = $1 WHERE id = $2`,
    ["ownership-pathway-a", "ownership-pathway-selection-b"],
    "teras_enrollment_pathway_history_guard",
  );
  await assertHistoryRejected(
    `UPDATE teras_enrollments SET pathway_id = $1 WHERE id = $2`,
    ["ownership-pathway-a-switch", "ownership-enrollment-a"],
    "teras_enrollment_context_identity_guard",
  );
  await assertHistoryRejected(
    `UPDATE teras_enrollments SET program_id = $1 WHERE id = $2`,
    ["ownership-program-b", "ownership-enrollment-a"],
    "teras_enrollment_context_identity_guard",
  );
  await assertHistoryRejected(
    `INSERT INTO teras_enrollment_pathway_events
       (id, enrollment_id, pathway_id, program_id, sequence, created_at)
     SELECT $1, $2, $3, $4, $5, created_at
     FROM teras_activity_completion_events
     WHERE id = $6`,
    ["ownership-equal-time-selection", "ownership-enrollment-a", "ownership-pathway-a",
      "ownership-program-a", 2, "context-after-pathway-selection"],
    "teras_enrollment_pathway_history_guard",
  );
  await assertHistoryRejected(
    `INSERT INTO teras_enrollment_pathway_events
       (id, enrollment_id, pathway_id, program_id, sequence, created_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    ["ownership-backdated-selection", "ownership-enrollment-a", "ownership-pathway-a",
      "ownership-program-a", 2, new Date("2000-01-01T00:00:00Z")],
    "teras_enrollment_pathway_history_guard",
  );

  await pathwayClient.query("BEGIN");
  await pathwayClient.query(`
    INSERT INTO teras_enrollment_pathway_events
      (id, enrollment_id, pathway_id, program_id, sequence)
    VALUES
      ('ownership-pathway-selection-race', 'ownership-enrollment-b',
       'ownership-pathway-b-switch', 'ownership-program-b', 1)
  `);

  await eventClient.query("BEGIN");
  const concurrentEvent = eventClient.query(`
    INSERT INTO teras_activity_completion_events
      (id, activity_id, learner_id, enrollment_id, pathway_id, status, actor_id)
    VALUES
      ('context-concurrent-pathway-selection', 'ownership-activity-b-switch',
       'ownership-learner-b', 'ownership-enrollment-b', 'ownership-pathway-b-switch',
       'completed', 'ownership-actor')
  `);
  await waitForEnrollmentLockWait();
  await pathwayClient.query("COMMIT");
  await concurrentEvent;
  await eventClient.query("COMMIT");

  const concurrentAudit = await client.query<{
    selection_created_at: Date;
    event_created_at: Date;
    pathway_id: string;
  }>(`
    SELECT
      selection.created_at AS selection_created_at,
      event.created_at AS event_created_at,
      event.pathway_id
    FROM teras_enrollment_pathway_events selection
    JOIN teras_activity_completion_events event
      ON event.enrollment_id = selection.enrollment_id
    WHERE selection.id = 'ownership-pathway-selection-race'
      AND event.id = 'context-concurrent-pathway-selection'
  `);
  assert.equal(concurrentAudit.rows.length, 1);
  assert.equal(concurrentAudit.rows[0]?.pathway_id, "ownership-pathway-b-switch");
  assert.ok(
    concurrentAudit.rows[0]!.selection_created_at <= concurrentAudit.rows[0]!.event_created_at,
    "the committed pathway selection must precede the concurrent event in audit time",
  );

  await client.query(contextMigration);

  console.info("LMS event ownership integration test passed");
} finally {
  await Promise.allSettled([
    pathwayClient.query("ROLLBACK"),
    eventClient.query("ROLLBACK"),
  ]);
  await Promise.all([client.end(), pathwayClient.end(), eventClient.end()]);
}