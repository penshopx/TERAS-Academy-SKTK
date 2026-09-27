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

async function waitForEnrollmentLockWait(
  applicationName: string,
  failureMessage: string,
) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const waiting = await client.query<{ waiting: boolean }>(`
      SELECT EXISTS (
        SELECT 1
        FROM pg_stat_activity
        WHERE application_name = $1
          AND wait_event_type = 'Lock'
      ) AS waiting
    `, [applicationName]);
    if (waiting.rows[0]?.waiting) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.fail(failureMessage);
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
      ('ownership-enrollment-b', 'ownership-learner-b', 'ownership-program-b', 'ownership-pathway-b', 'active'),
      ('ownership-enrollment-c', 'ownership-learner-c', 'ownership-program-c', 'ownership-pathway-c', 'active')
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
       'lesson', 'Activity B switch', 'Second pathway in program B', 1),
      ('ownership-activity-c', 'ownership-lesson-c', 'ownership-program-c', 'ownership-pathway-c',
       'lesson', 'Activity C', 'Context C', 1),
      ('ownership-activity-c-switch', 'ownership-lesson-c-switch', 'ownership-program-c', 'ownership-pathway-c-switch',
       'lesson', 'Activity C switch', 'Second pathway in program C', 1)
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

  // Migration 0033 recovers selection history only for this exact legacy demo fixture.
  // Keep its source events valid so the separate context mismatch below causes the failure.
  await client.query(`
    INSERT INTO teras_enrollments
      (id, learner_id, program_id, pathway_id, status)
    VALUES ('enrol-demo', 'learner-demo', 'ownership-program-a', 'ownership-pathway-a', 'active')
  `);
  await client.query(`
    INSERT INTO teras_activity_completion_events
      (id, activity_id, learner_id, enrollment_id, pathway_id, status, actor_id, created_at)
    VALUES
      ('context-demo-original', 'ownership-activity-a', 'learner-demo',
       'enrol-demo', 'ownership-pathway-a', 'completed', 'ownership-actor',
       '2020-01-01T00:00:00Z'),
      ('context-demo-switch', 'ownership-activity-a-switch', 'learner-demo',
       'enrol-demo', 'ownership-pathway-a-switch', 'completed', 'ownership-actor',
       '2020-01-02T00:00:00Z')
  `);
  const demoSelections = async () => (await client.query<{
    pathway_id: string;
    program_id: string;
    sequence: number;
    created_by: string;
  }>(`
    SELECT pathway_id, program_id, sequence, created_by
    FROM teras_enrollment_pathway_events
    WHERE enrollment_id = 'enrol-demo'
    ORDER BY sequence
  `)).rows;
  assert.deepEqual(await demoSelections(), [], "the demo fixture starts without selection history");

  const contextPreflightCases = [
    {
      table: "teras_activity_completion_events",
      insert: `
        INSERT INTO teras_activity_completion_events
          (id, activity_id, learner_id, enrollment_id, pathway_id, status, actor_id)
        VALUES
          ('context-legacy-mismatch', 'ownership-activity-b', 'ownership-learner-a',
           'ownership-enrollment-a', 'ownership-pathway-b', 'completed', 'ownership-actor')
      `,
    },
    {
      table: "teras_outcome_verification_events",
      insert: `
        INSERT INTO teras_outcome_verification_events
          (id, outcome_id, activity_id, learner_id, enrollment_id, pathway_id,
           verifier_id, result, reason)
        VALUES
          ('context-legacy-mismatch', 'ownership-outcome-b', 'ownership-activity-a',
           'ownership-learner-a', 'ownership-enrollment-a', 'ownership-pathway-a',
           'ownership-verifier', 'verified', 'legacy outcome context mismatch')
      `,
    },
    {
      table: "teras_readiness_transfer_events",
      insert: `
        INSERT INTO teras_readiness_transfer_events
          (id, learner_id, enrollment_id, program_id, pathway_id, source_context, triggered_by)
        VALUES
          ('context-legacy-mismatch', 'ownership-learner-a', 'ownership-enrollment-a',
           'ownership-program-b', 'ownership-pathway-a', '{}'::jsonb, 'ownership-actor')
      `,
    },
    {
      table: "teras_learning_transition_events",
      insert: `
        INSERT INTO teras_learning_transition_events
          (id, activity_id, learner_id, enrollment_id, program_id, pathway_id,
           from_state, to_state, actor_id, actor_role, entity_reference, reason, idempotency_key)
        VALUES
          ('context-legacy-mismatch', 'ownership-activity-b', 'ownership-learner-a',
           'ownership-enrollment-a', 'ownership-program-a', 'ownership-pathway-a',
           'assigned', 'started', 'ownership-actor', 'learner', 'ownership-activity-b',
           'legacy activity context mismatch', 'context-legacy-mismatch')
      `,
    },
    {
      table: "teras_readiness_events",
      insert: `
        INSERT INTO teras_readiness_events
          (id, enrollment_id, pathway_id, gate_id, status, score)
        VALUES
          ('context-legacy-mismatch', 'ownership-enrollment-a', 'ownership-pathway-a',
           'ownership-gate-b', 'Developing', 50)
      `,
    },
  ] as const;

  for (const preflightCase of contextPreflightCases) {
    await client.query(preflightCase.insert);
    await assert.rejects(
      client.query(contextMigration),
      new RegExp(
        `Cannot enforce enrollment event context: program or pathway mismatch in ${preflightCase.table}`,
      ),
    );
    await client.query("ROLLBACK");
    assert.deepEqual(
      await demoSelections(),
      [],
      `failed ${preflightCase.table} preflight must roll back demo pathway recovery`,
    );
    await client.query(
      `DELETE FROM ${preflightCase.table} WHERE id = 'context-legacy-mismatch'`,
    );
  }
  await client.query(contextMigration);
  const recoveredDemoSelections = [{
    pathway_id: "ownership-pathway-a-switch",
    program_id: "ownership-program-a",
    sequence: 1,
    created_by: "migration-0033-context-recovery",
  }];
  assert.deepEqual(
    await demoSelections(),
    recoveredDemoSelections,
    "corrected context allows exactly one recovered demo pathway selection",
  );
  await client.query(contextMigration);
  assert.deepEqual(
    await demoSelections(),
    recoveredDemoSelections,
    "reapplying migration 0033 does not duplicate recovered selection history",
  );

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

  await client.query(`
    INSERT INTO teras_enrollments
      (id, learner_id, program_id, pathway_id, status)
    SELECT
      'ownership-race-enrollment-' || race_id,
      'ownership-race-learner-' || race_id,
      'ownership-race-program-' || race_id,
      'ownership-race-pathway-base-' || race_id,
      'active'
    FROM generate_series(1, 20) AS race_id
  `);
  await client.query(`
    INSERT INTO teras_learning_activities
      (id, lesson_id, program_id, pathway_id, type, title, description, sequence)
    SELECT
      'ownership-race-base-activity-' || race_id,
      'ownership-race-base-lesson-' || race_id,
      'ownership-race-program-' || race_id,
      'ownership-race-pathway-base-' || race_id,
      'lesson',
      'Race base activity ' || race_id,
      'Concurrent original pathway context',
      1
    FROM generate_series(6, 20) AS race_id
  `);
  await client.query(`
    INSERT INTO teras_learning_activities
      (id, lesson_id, program_id, pathway_id, type, title, description, sequence)
    SELECT
      'ownership-race-activity-' || race_id,
      'ownership-race-lesson-' || race_id,
      'ownership-race-program-' || race_id,
      'ownership-race-pathway-latest-' || race_id,
      'lesson',
      'Race activity ' || race_id,
      'Concurrent pathway context',
      1
    FROM generate_series(1, 20) AS race_id
  `);
  await client.query(`
    INSERT INTO teras_learning_outcomes
      (id, activity_id, description, verification_method, sequence)
    SELECT
      'ownership-race-outcome-' || race_id,
      'ownership-race-activity-' || race_id,
      'Race outcome ' || race_id,
      'review',
      1
    FROM generate_series(1, 20) AS race_id
  `);
  await client.query(`
    INSERT INTO teras_learning_outcomes
      (id, activity_id, description, verification_method, sequence)
    SELECT
      'ownership-race-base-outcome-' || race_id,
      'ownership-race-base-activity-' || race_id,
      'Race base outcome ' || race_id,
      'review',
      1
    FROM generate_series(6, 20) AS race_id
  `);
  await client.query(`
    INSERT INTO teras_readiness_gates
      (id, program_id, pathway_id, sequence, code, name, requirement)
    SELECT
      'ownership-race-gate-' || race_id,
      'ownership-race-program-' || race_id,
      'ownership-race-pathway-latest-' || race_id,
      1,
      'RACE-' || race_id,
      'Race gate ' || race_id,
      'Concurrent pathway requirement'
    FROM generate_series(1, 20) AS race_id
  `);
  await client.query(`
    INSERT INTO teras_readiness_gates
      (id, program_id, pathway_id, sequence, code, name, requirement)
    SELECT
      'ownership-race-base-gate-' || race_id,
      'ownership-race-program-' || race_id,
      'ownership-race-pathway-base-' || race_id,
      1,
      'RACE-BASE-' || race_id,
      'Race base gate ' || race_id,
      'Concurrent original pathway requirement'
    FROM generate_series(6, 20) AS race_id
  `);

  const concurrentEventCases = [
    {
      name: "activity completion",
      table: "teras_activity_completion_events",
      columns: "id, activity_id, learner_id, enrollment_id, pathway_id, status, actor_id",
      values: "$1, $2, $3, $4, $5, 'completed', 'ownership-actor'",
      argumentIndexes: [0, 1, 2, 3, 4],
      context: {
        activityId: "ownership-race-activity-1",
        outcomeId: null,
        gateId: null,
      },
    },
    {
      name: "outcome verification",
      table: "teras_outcome_verification_events",
      columns: "id, outcome_id, activity_id, learner_id, enrollment_id, pathway_id, verifier_id, result, reason",
      values: "$1, $2, $3, $4, $5, $6, 'ownership-verifier', 'verified', 'concurrent pathway'",
      argumentIndexes: [0, 5, 1, 2, 3, 4],
      context: {
        activityId: "ownership-race-activity-2",
        outcomeId: "ownership-race-outcome-2",
        gateId: null,
      },
    },
    {
      name: "readiness transfer",
      table: "teras_readiness_transfer_events",
      columns: "id, learner_id, enrollment_id, program_id, pathway_id, source_context, triggered_by",
      values: "$1, $2, $3, $4, $5, '{}'::jsonb, 'ownership-actor'",
      argumentIndexes: [0, 2, 3, 6, 4],
      context: {
        activityId: null,
        outcomeId: null,
        gateId: null,
      },
    },
    {
      name: "learning transition",
      table: "teras_learning_transition_events",
      columns: `id, activity_id, learner_id, enrollment_id, program_id, pathway_id,
        from_state, to_state, actor_id, actor_role, entity_reference, reason, idempotency_key`,
      values: `$1, $2, $3, $4, $5, $6, 'assigned', 'started', 'ownership-actor',
        'learner', $2, 'concurrent pathway', $1`,
      argumentIndexes: [0, 1, 2, 3, 6, 4],
      context: {
        activityId: "ownership-race-activity-4",
        outcomeId: null,
        gateId: null,
      },
    },
    {
      name: "readiness event",
      table: "teras_readiness_events",
      columns: "id, enrollment_id, pathway_id, gate_id, status, score",
      values: "$1, $2, $3, $4, 'Developing', 50",
      argumentIndexes: [0, 3, 4, 7],
      context: {
        activityId: null,
        outcomeId: null,
        gateId: "ownership-race-gate-5",
      },
    },
  ] as const;

  for (const [index, eventCase] of concurrentEventCases.entries()) {
    const raceId = index + 1;
    const eventId = `context-concurrent-${eventCase.table}`;
    const enrollmentId = `ownership-race-enrollment-${raceId}`;
    const learnerId = `ownership-race-learner-${raceId}`;
    const programId = `ownership-race-program-${raceId}`;
    const pathwayId = `ownership-race-pathway-latest-${raceId}`;
    const selectionId = `ownership-race-selection-${raceId}`;
    const activityId = `ownership-race-activity-${raceId}`;
    const outcomeId = `ownership-race-outcome-${raceId}`;
    const gateId = `ownership-race-gate-${raceId}`;

    await pathwayClient.query("BEGIN");
    await pathwayClient.query(
      `INSERT INTO teras_enrollment_pathway_events
         (id, enrollment_id, pathway_id, program_id, sequence)
       VALUES ($1, $2, $3, $4, 1)`,
      [selectionId, enrollmentId, pathwayId, programId],
    );

    await eventClient.query("BEGIN");
    const concurrentEvent = eventClient.query(
      `INSERT INTO ${eventCase.table} (${eventCase.columns})
       VALUES (${eventCase.values})`,
      eventCase.argumentIndexes.map(index =>
        [eventId, activityId, learnerId, enrollmentId, pathwayId, outcomeId, programId, gateId][index]
      ),
    );
    await waitForEnrollmentLockWait(
      "lms-event-ownership-event-race",
      `${eventCase.name} did not wait for the enrollment row lock`,
    );
    await pathwayClient.query("COMMIT");
    await concurrentEvent;
    await eventClient.query("COMMIT");

    const concurrentAudit = await client.query<{
      selection_created_at: Date;
      event_created_at: Date;
      program_id: string;
      pathway_id: string;
      activity_id: string | null;
      outcome_id: string | null;
      gate_id: string | null;
    }>(`
      SELECT
        selection.created_at AS selection_created_at,
        event.created_at AS event_created_at,
        enrollment.program_id,
        event.pathway_id,
        to_jsonb(event)->>'activity_id' AS activity_id,
        to_jsonb(event)->>'outcome_id' AS outcome_id,
        to_jsonb(event)->>'gate_id' AS gate_id
      FROM teras_enrollment_pathway_events selection
      JOIN ${eventCase.table} event
        ON event.enrollment_id = selection.enrollment_id
      JOIN teras_enrollments enrollment
        ON enrollment.id = event.enrollment_id
      WHERE selection.id = $1
        AND event.id = $2
    `, [selectionId, eventId]);
    assert.equal(concurrentAudit.rows.length, 1);
    assert.deepEqual(
      {
        programId: concurrentAudit.rows[0]?.program_id,
        pathwayId: concurrentAudit.rows[0]?.pathway_id,
        activityId: concurrentAudit.rows[0]?.activity_id ?? null,
        outcomeId: concurrentAudit.rows[0]?.outcome_id ?? null,
        gateId: concurrentAudit.rows[0]?.gate_id ?? null,
      },
      {
        programId,
        pathwayId,
        ...eventCase.context,
      },
      `${eventCase.name} must retain its committed enrollment context`,
    );
    assert.ok(
      concurrentAudit.rows[0]!.selection_created_at <= concurrentAudit.rows[0]!.event_created_at,
      `the committed pathway selection must precede the concurrent ${eventCase.name}`,
    );
  }

  for (const [index, eventCase] of concurrentEventCases.entries()) {
    const raceId = index + 6;
    const eventId = `context-event-first-${eventCase.table}`;
    const enrollmentId = `ownership-race-enrollment-${raceId}`;
    const learnerId = `ownership-race-learner-${raceId}`;
    const programId = `ownership-race-program-${raceId}`;
    const originalPathwayId = `ownership-race-pathway-base-${raceId}`;
    const laterPathwayId = `ownership-race-pathway-latest-${raceId}`;
    const selectionId = `ownership-event-first-selection-${raceId}`;
    const activityId = `ownership-race-base-activity-${raceId}`;
    const outcomeId = `ownership-race-base-outcome-${raceId}`;
    const gateId = `ownership-race-base-gate-${raceId}`;

    await eventClient.query("BEGIN");
    await eventClient.query(
      `INSERT INTO ${eventCase.table} (${eventCase.columns})
       VALUES (${eventCase.values})`,
      eventCase.argumentIndexes.map(argumentIndex =>
        [
          eventId,
          activityId,
          learnerId,
          enrollmentId,
          originalPathwayId,
          outcomeId,
          programId,
          gateId,
        ][argumentIndex]
      ),
    );

    await pathwayClient.query("BEGIN");
    const concurrentBackdatedSelection = assert.rejects(
      pathwayClient.query(
        `INSERT INTO teras_enrollment_pathway_events
           (id, enrollment_id, pathway_id, program_id, sequence, created_at)
         VALUES ($1, $2, $3, $4, 1, '2000-01-01T00:00:00Z'::timestamptz)`,
        [selectionId, enrollmentId, laterPathwayId, programId],
      ),
      (error: unknown) => {
        if (!(error instanceof Error)) return false;
        const databaseError = error as Error & { code?: string; constraint?: string };
        return databaseError.code === "23514"
          && databaseError.constraint === "teras_enrollment_pathway_history_guard";
      },
      `the backdated pathway selection must be rejected after the concurrent ${eventCase.name} commits`,
    );
    await waitForEnrollmentLockWait(
      "lms-event-ownership-pathway-race",
      `${eventCase.name} did not make the pathway selection wait for the enrollment row lock`,
    );
    await eventClient.query("COMMIT");
    await concurrentBackdatedSelection;
    await pathwayClient.query("ROLLBACK");

    const eventFirstAudit = await client.query<{
      id: string;
      program_id: string;
      pathway_id: string;
      activity_id: string | null;
      outcome_id: string | null;
      gate_id: string | null;
      selection_count: string;
    }>(`
      SELECT
        event.id,
        enrollment.program_id,
        event.pathway_id,
        to_jsonb(event)->>'activity_id' AS activity_id,
        to_jsonb(event)->>'outcome_id' AS outcome_id,
        to_jsonb(event)->>'gate_id' AS gate_id,
        count(selection.id)::text AS selection_count
      FROM ${eventCase.table} event
      JOIN teras_enrollments enrollment
        ON enrollment.id = event.enrollment_id
      LEFT JOIN teras_enrollment_pathway_events selection
        ON selection.enrollment_id = event.enrollment_id
      WHERE event.id = $1
      GROUP BY event.id, enrollment.program_id, event.pathway_id
    `, [eventId]);
    assert.deepEqual(eventFirstAudit.rows, [{
      id: eventId,
      program_id: programId,
      pathway_id: originalPathwayId,
      activity_id: eventCase.context.activityId ? activityId : null,
      outcome_id: eventCase.context.outcomeId ? outcomeId : null,
      gate_id: eventCase.context.gateId ? gateId : null,
      selection_count: "0",
    }], `the committed ${eventCase.name} remains in its original context after the selection is rejected`);
  }

  for (const [index, eventCase] of concurrentEventCases.entries()) {
    for (const updateKind of ["context", "created_at"] as const) {
      const raceId = index + (updateKind === "context" ? 11 : 16);
      const eventId = `context-update-${updateKind}-${eventCase.table}`;
      const enrollmentId = `ownership-race-enrollment-${raceId}`;
      const learnerId = `ownership-race-learner-${raceId}`;
      const programId = `ownership-race-program-${raceId}`;
      const originalPathwayId = `ownership-race-pathway-base-${raceId}`;
      const laterPathwayId = `ownership-race-pathway-latest-${raceId}`;
      const selectionId = `ownership-update-selection-${raceId}`;
      const originalActivityId = `ownership-race-base-activity-${raceId}`;
      const originalOutcomeId = `ownership-race-base-outcome-${raceId}`;
      const originalGateId = `ownership-race-base-gate-${raceId}`;
      const laterActivityId = `ownership-race-activity-${raceId}`;
      const laterOutcomeId = `ownership-race-outcome-${raceId}`;
      const laterGateId = `ownership-race-gate-${raceId}`;

      await client.query(
        `INSERT INTO ${eventCase.table} (${eventCase.columns})
         VALUES (${eventCase.values})`,
        eventCase.argumentIndexes.map(argumentIndex =>
          [
            eventId,
            originalActivityId,
            learnerId,
            enrollmentId,
            originalPathwayId,
            originalOutcomeId,
            programId,
            originalGateId,
          ][argumentIndex]
        ),
      );
      const beforeUpdate = await client.query<{ event: Record<string, unknown> }>(
        `SELECT to_jsonb(event) AS event FROM ${eventCase.table} event WHERE id = $1`,
        [eventId],
      );

      await pathwayClient.query("BEGIN");
      await pathwayClient.query(
        `INSERT INTO teras_enrollment_pathway_events
           (id, enrollment_id, pathway_id, program_id, sequence)
         VALUES ($1, $2, $3, $4, 1)`,
        [selectionId, enrollmentId, laterPathwayId, programId],
      );

      await eventClient.query("BEGIN");
      const contextAssignments = eventCase.table === "teras_activity_completion_events"
        ? "activity_id = $3, pathway_id = $2, created_at = created_at"
        : eventCase.table === "teras_outcome_verification_events"
          ? "outcome_id = $4, activity_id = $3, pathway_id = $2, created_at = created_at"
          : eventCase.table === "teras_readiness_transfer_events"
            ? "pathway_id = $2, created_at = created_at"
            : eventCase.table === "teras_learning_transition_events"
              ? "activity_id = $3, pathway_id = $2, created_at = created_at"
              : "gate_id = $3, pathway_id = $2, created_at = created_at";
      const updateSql = updateKind === "created_at"
        ? `UPDATE ${eventCase.table}
           SET created_at = clock_timestamp()
           WHERE id = $1`
        : `UPDATE ${eventCase.table}
           SET ${contextAssignments}
           WHERE id = $1`;
      const contextConstraint = eventCase.table === "teras_readiness_events"
        ? "teras_readiness_events_enrollment_context_guard"
        : `${eventCase.table.replace(/_events$/, "")}_enrollment_context_guard`;
      const updateValues = updateKind === "created_at"
        ? [eventId]
        : eventCase.table === "teras_activity_completion_events"
          ? [eventId, laterPathwayId, laterActivityId]
          : eventCase.table === "teras_outcome_verification_events"
            ? [eventId, laterPathwayId, laterActivityId, laterOutcomeId]
            : eventCase.table === "teras_readiness_transfer_events"
              ? [eventId, laterPathwayId]
              : eventCase.table === "teras_learning_transition_events"
                ? [eventId, laterPathwayId, laterActivityId]
                : [eventId, laterPathwayId, laterGateId];
      const concurrentUpdate = assert.rejects(
        eventClient.query(updateSql, updateValues),
        (error: unknown) => {
          if (!(error instanceof Error)) return false;
          const databaseError = error as Error & { code?: string; constraint?: string };
          return databaseError.code === "23503"
            && databaseError.constraint === contextConstraint;
        },
        `the concurrent ${eventCase.name} ${updateKind} update must use pathway history after the lock`,
      );
      await waitForEnrollmentLockWait(
        "lms-event-ownership-event-race",
        `${eventCase.name} ${updateKind} update did not wait for the enrollment row lock`,
      );
      await pathwayClient.query("COMMIT");
      await concurrentUpdate;
      await eventClient.query("ROLLBACK");

      const afterUpdate = await client.query<{
        event: Record<string, unknown>;
        selection_count: string;
      }>(
        `SELECT
           to_jsonb(event) AS event,
           count(selection.id)::text AS selection_count
         FROM ${eventCase.table} event
         LEFT JOIN teras_enrollment_pathway_events selection
           ON selection.enrollment_id = event.enrollment_id
         WHERE event.id = $1
         GROUP BY event.id`,
        [eventId],
      );
      assert.deepEqual(
        afterUpdate.rows,
        [{ event: beforeUpdate.rows[0]!.event, selection_count: "1" }],
        `the rejected ${eventCase.name} ${updateKind} update must not change the committed event or pathway history`,
      );
    }
  }

  await client.query(contextMigration);

  console.info("LMS event ownership integration test passed");
} finally {
  await Promise.allSettled([
    pathwayClient.query("ROLLBACK"),
    eventClient.query("ROLLBACK"),
  ]);
  await Promise.all([client.end(), pathwayClient.end(), eventClient.end()]);
}