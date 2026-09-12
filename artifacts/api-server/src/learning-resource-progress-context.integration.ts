import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import pg from "pg";
import { createIntegrationTestApp } from "./integration-test-app";

const { Client } = pg;
const client = new Client({ connectionString: process.env.DATABASE_URL });
const suffix = crypto.randomUUID();
const learnerA = `progress-learner-a-${suffix}`;
const learnerB = `progress-learner-b-${suffix}`;
const enrollment = `progress-enrollment-${suffix}`;
const validId = `progress-valid-${suffix}`;
const activityA = `progress-activity-a-${suffix}`;
const activityB = `progress-activity-b-${suffix}`;
const resourceA = `progress-resource-a-${suffix}`;
const resourceB = `progress-resource-b-${suffix}`;

async function rejectsWithoutAborting(
  name: string,
  operation: () => Promise<unknown>,
  expected: RegExp,
) {
  await client.query(`SAVEPOINT ${name}`);
  try {
    await assert.rejects(operation(), expected);
  } finally {
    await client.query(`ROLLBACK TO SAVEPOINT ${name}`);
    await client.query(`RELEASE SAVEPOINT ${name}`);
  }
}

await client.connect();
try {
  await client.query("BEGIN");
  const context = await client.query<{
    schema_name: string;
    constraint_name: string | null;
  }>(`
    SELECT current_schema() AS schema_name, tc.constraint_name
    FROM (VALUES (1)) marker(value)
    LEFT JOIN information_schema.table_constraints tc
      ON tc.table_schema = current_schema()
     AND tc.table_name = 'teras_learning_resource_progress'
     AND tc.constraint_name = 'teras_learning_resource_progress_enrollment_learner_fk'
  `);
  assert.equal(context.rows[0]?.constraint_name, "teras_learning_resource_progress_enrollment_learner_fk");
  await client.query(`
    INSERT INTO teras_people (id, name, initials, email, role, organization)
    VALUES
      ($1, 'Progress learner A', 'PA', $3, 'learner', 'TERAS test'),
      ($2, 'Progress learner B', 'PB', $4, 'learner', 'TERAS test')
  `, [learnerA, learnerB, `${learnerA}@example.test`, `${learnerB}@example.test`]);
  await client.query(`
    INSERT INTO teras_enrollments (id, learner_id, program_id, pathway_id)
    VALUES ($1, $2, 'solar-pv-tech', 'path-a')
  `, [enrollment, learnerA]);
  await client.query(`
    INSERT INTO teras_learning_activities
      (id, lesson_id, program_id, pathway_id, type, title, description, sequence)
    VALUES
      ($1, 'progress-lesson-a', 'solar-pv-tech', 'path-a', 'READ', 'Shared activity', 'Shared', 901),
      ($2, 'progress-lesson-b', 'solar-pv-tech', 'path-a', 'READ', 'Other activity', 'Other', 902)
  `, [activityA, activityB]);
  await client.query(`
    INSERT INTO teras_content_resources
      (id, activity_id, type, title, content, sequence)
    VALUES
      ($1, $2, 'TEXT', 'Resource A', 'A', 901),
      ($3, $4, 'TEXT', 'Resource B', 'B', 902)
  `, [resourceA, activityA, resourceB, activityB]);

  await client.query(`
    INSERT INTO teras_learning_resource_progress
      (id, learner_id, enrollment_id, pathway_id, activity_id, resource_id, position)
    VALUES ($1, $2, $3, 'path-a', $4, $5, 12)
  `, [validId, learnerA, enrollment, activityA, resourceA]);

  const valid = await client.query<{ position: number }>(
    "SELECT position FROM teras_learning_resource_progress WHERE id = $1",
    [validId],
  );
  assert.equal(valid.rows[0]?.position, 12);

  await rejectsWithoutAborting(
    "wrong_learner",
    () => client.query(`
      INSERT INTO teras_learning_resource_progress
        (id, learner_id, enrollment_id, pathway_id, activity_id, resource_id)
      VALUES ($1, $2, $3, 'path-a', $4, $5)
    `, [`progress-wrong-learner-${suffix}`, learnerB, enrollment, activityA, resourceA]),
    /teras_learning_resource_progress_enrollment_learner_fk/,
  );

  await rejectsWithoutAborting(
    "wrong_resource",
    () => client.query(`
      INSERT INTO teras_learning_resource_progress
        (id, learner_id, enrollment_id, pathway_id, activity_id, resource_id)
      VALUES ($1, $2, $3, 'path-a', $4, $5)
    `, [`progress-wrong-resource-${suffix}`, learnerA, enrollment, activityA, resourceB]),
    /teras_learning_resource_progress_resource_activity_fk/,
  );

  await client.query(`
    INSERT INTO teras_enrollment_pathway_events
      (id, enrollment_id, pathway_id, program_id, sequence)
    VALUES ($1, $2, 'path-b', 'solar-pv-tech', 1)
  `, [`progress-pathway-event-${suffix}`, enrollment]);

  const pathBInitial = await client.query<{ position: number }>(`
    SELECT position
    FROM teras_learning_resource_progress
    WHERE learner_id = $1 AND enrollment_id = $2 AND pathway_id = 'path-b'
      AND activity_id = $3 AND resource_id = $4
  `, [learnerA, enrollment, activityA, resourceA]);
  assert.equal(pathBInitial.rowCount, 0, "Path A position leaked into Path B resume scope");

  await client.query(`
    INSERT INTO teras_learning_resource_progress
      (id, learner_id, enrollment_id, pathway_id, activity_id, resource_id, position)
    VALUES ($1, $2, $3, 'path-b', $4, $5, 34)
  `, [`progress-path-b-${suffix}`, learnerA, enrollment, activityA, resourceA]);

  const pathBResume = await client.query<{ position: number }>(`
    SELECT position
    FROM teras_learning_resource_progress
    WHERE learner_id = $1 AND enrollment_id = $2 AND pathway_id = 'path-b'
      AND activity_id = $3 AND resource_id = $4
  `, [learnerA, enrollment, activityA, resourceA]);
  assert.equal(pathBResume.rows[0]?.position, 34);

  await rejectsWithoutAborting(
    "stale_pathway_write",
    () => client.query(
      "UPDATE teras_learning_resource_progress SET position = 99 WHERE id = $1",
      [validId],
    ),
    /Resource progress context does not match active pathway/,
  );

  await client.query("ROLLBACK");

  const app = createIntegrationTestApp(() => ({
    userId: "progress-context-user",
    role: "learner",
    learnerId: "learner-demo",
  }));
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  const request = async (method: "GET" | "PUT", body?: { position: number }) => {
    const response = await fetch(`${baseUrl}/learning/resources/resource-m01/progress`, {
      method,
      headers: { "content-type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    const responseBody = await response.text();
    assert.equal(response.status, 200, responseBody);
    return JSON.parse(responseBody) as { position: number };
  };

  try {
    assert.equal((await request("PUT", { position: 12 })).position, 12);
    await client.query(`
      INSERT INTO teras_enrollment_pathway_events
        (id, enrollment_id, pathway_id, program_id, sequence, created_by)
      VALUES ($1, 'enrol-demo', 'path-b', 'solar-pv-tech', 1, 'learner-demo')
    `, [`progress-api-switch-${suffix}`]);

    assert.equal((await request("GET")).position, 0, "Path A position leaked into Path B API resume");
    assert.equal((await request("PUT", { position: 34 })).position, 34);
    assert.equal((await request("GET")).position, 34);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }

  process.stdout.write("Learning resource progress context integration check passed\n");
} finally {
  await client.query("ROLLBACK").catch(() => undefined);
  await client.end();
}