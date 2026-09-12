import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import pg from "pg";

const { Client } = pg;
const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error("DATABASE_URL is required for the causal link ownership integration test");
}

const migration = await readFile(
  new URL("../../../lib/db/migrations/0032_learning_record_link_ownership.sql", import.meta.url),
  "utf8",
);
const client = new Client({ connectionString: databaseUrl });

async function assertMixedOwnershipRejected(sql: string, values: unknown[], constraint: string) {
  await assert.rejects(
    client.query(sql, values),
    (error: unknown) => {
      if (!(error instanceof Error)) return false;
      const databaseError = error as Error & { code?: string; constraint?: string };
      return databaseError.code === "23514" && databaseError.constraint === constraint;
    },
    `Expected ${constraint} to reject mixed learner ownership`,
  );
}

await client.connect();
try {
  await client.query(`
    INSERT INTO teras_people (id, name, initials, role)
    VALUES ('causal-owner-b', 'Causal Owner B', 'CB', 'Learner');

    INSERT INTO teras_practice_attempts
      (id, task_id, learner_id, pathway_id, reflection, output_summary, status)
    VALUES
      ('causal-practice-a', 'task-m01', 'learner-demo', 'path-a', 'a', 'a', 'Submitted'),
      ('causal-practice-b', 'task-m01', 'causal-owner-b', 'path-a', 'b', 'b', 'Submitted');

    INSERT INTO teras_evidence
      (id, learner_id, pathway_id, module_id, task_id, title, type, description)
    VALUES
      ('causal-evidence-a', 'learner-demo', 'path-a', 'm01', 'task-m01', 'A', 'Document', 'A'),
      ('causal-evidence-b', 'causal-owner-b', 'path-a', 'm01', 'task-m01', 'B', 'Document', 'B');

    INSERT INTO teras_evidence_reviews
      (id, evidence_id, status, quality)
    VALUES
      ('causal-review-a', 'causal-evidence-a', 'Accepted',
       '{"valid":true,"relevant":true,"sufficient":true,"traceable":true}'::jsonb),
      ('causal-review-b', 'causal-evidence-b', 'Accepted',
       '{"valid":true,"relevant":true,"sufficient":true,"traceable":true}'::jsonb);

    INSERT INTO teras_gaps
      (id, learner_id, pathway_id, module_id, capability, criterion, severity,
       priority, diagnosis, gate, recommended_action)
    VALUES
      ('causal-gap-a', 'learner-demo', 'path-a', 'm01', 'A', 'A', 'Low', 'Low', 'A', 'A', 'A'),
      ('causal-gap-b', 'causal-owner-b', 'path-a', 'm01', 'B', 'B', 'Low', 'Low', 'B', 'B', 'B');

    INSERT INTO teras_remediation_plans (id, gap_id, title, description)
    VALUES
      ('causal-plan-a', 'causal-gap-a', 'A', 'A'),
      ('causal-plan-b', 'causal-gap-b', 'B', 'B');

    INSERT INTO teras_assessment_attempts
      (id, assessment_id, learner_id, pathway_id, number, status)
    VALUES
      ('causal-assessment-a1', 'assessment-m01', 'learner-demo', 'path-a', 101, 'Completed'),
      ('causal-assessment-a2', 'assessment-m01', 'learner-demo', 'path-a', 102, 'Completed'),
      ('causal-assessment-b1', 'assessment-m01', 'causal-owner-b', 'path-a', 101, 'Completed'),
      ('causal-assessment-b2', 'assessment-m01', 'causal-owner-b', 'path-a', 102, 'Completed');
  `);

  await client.query(`
    INSERT INTO teras_learning_record_links
      (id, learner_id, pathway_id, activity_id, practice_attempt_id, evidence_id,
       evidence_review_id, gap_id, remediation_plan_id, reassessment_attempt_id, relation)
    VALUES
      ('causal-legacy-mismatch', 'learner-demo', 'path-a', 'activity-m03-safe-isolation',
       'causal-practice-b', 'causal-evidence-a', 'causal-review-a', 'causal-gap-a',
       'causal-plan-a', 'causal-assessment-a2', 'causes')
  `);
  await assert.rejects(
    client.query(migration),
    /Cannot enforce causal link ownership: parent learner differs from link learner in teras_learning_record_links/,
  );
  await client.query("ROLLBACK");
  await client.query("DELETE FROM teras_learning_record_links WHERE id = 'causal-legacy-mismatch'");

  await client.query(`
    INSERT INTO teras_reassessment_links
      (id, learner_id, pathway_id, original_gap_id, remediation_plan_id,
       practice_attempt_id, evidence_id, reassessment_attempt_id, previous_assessment_attempt_id)
    VALUES
      ('causal-legacy-reassessment-mismatch', 'learner-demo', 'path-a', 'causal-gap-a',
       'causal-plan-a', 'causal-practice-a', 'causal-evidence-a',
       'causal-assessment-a2', 'causal-assessment-b1')
  `);
  await assert.rejects(
    client.query(migration),
    /Cannot enforce causal link ownership: parent learner differs from link learner in teras_reassessment_links/,
  );
  await client.query("ROLLBACK");
  await client.query(
    "DELETE FROM teras_reassessment_links WHERE id = 'causal-legacy-reassessment-mismatch'",
  );

  await client.query(migration);
  await client.query(migration);

  await client.query(`
    INSERT INTO teras_learning_record_links
      (id, learner_id, pathway_id, activity_id, practice_attempt_id, evidence_id,
       evidence_review_id, gap_id, remediation_plan_id, reassessment_attempt_id, relation)
    VALUES
      ('causal-record-valid', 'learner-demo', 'path-a', 'activity-m03-safe-isolation',
       'causal-practice-a', 'causal-evidence-a', 'causal-review-a', 'causal-gap-a',
       'causal-plan-a', 'causal-assessment-a2', 'causes')
  `);
  const learningRecordParents = [
    ["practice_attempt_id", "causal-practice-b"],
    ["evidence_id", "causal-evidence-b"],
    ["evidence_review_id", "causal-review-b"],
    ["gap_id", "causal-gap-b"],
    ["remediation_plan_id", "causal-plan-b"],
    ["reassessment_attempt_id", "causal-assessment-b2"],
  ] as const;
  for (const [column, mixedOwnerId] of learningRecordParents) {
    await assertMixedOwnershipRejected(
      `INSERT INTO teras_learning_record_links
        (id, learner_id, pathway_id, activity_id, ${column}, relation)
       VALUES ($1, 'learner-demo', 'path-a', 'activity-m03-safe-isolation', $2, 'causes')`,
      [`causal-record-invalid-${column}`, mixedOwnerId],
      "teras_learning_record_links_learner_ownership",
    );
  }
  await assertMixedOwnershipRejected(
    "UPDATE teras_learning_record_links SET practice_attempt_id = $1 WHERE id = $2",
    ["causal-practice-b", "causal-record-valid"],
    "teras_learning_record_links_learner_ownership",
  );

  await client.query(`
    INSERT INTO teras_reassessment_links
      (id, learner_id, pathway_id, original_gap_id, remediation_plan_id,
       practice_attempt_id, evidence_id, reassessment_attempt_id, previous_assessment_attempt_id)
    VALUES
      ('causal-reassessment-valid', 'learner-demo', 'path-a', 'causal-gap-a',
       'causal-plan-a', 'causal-practice-a', 'causal-evidence-a',
       'causal-assessment-a2', 'causal-assessment-a1')
  `);
  const reassessmentParents = [
    ["original_gap_id", "causal-gap-b"],
    ["remediation_plan_id", "causal-plan-b"],
    ["practice_attempt_id", "causal-practice-b"],
    ["evidence_id", "causal-evidence-b"],
    ["reassessment_attempt_id", "causal-assessment-b2"],
    ["previous_assessment_attempt_id", "causal-assessment-b1"],
  ] as const;
  for (const [column, mixedOwnerId] of reassessmentParents) {
    const values = {
      original_gap_id: "causal-gap-a",
      remediation_plan_id: "causal-plan-a",
      practice_attempt_id: "causal-practice-a",
      evidence_id: "causal-evidence-a",
      reassessment_attempt_id: "causal-assessment-a2",
      previous_assessment_attempt_id: "causal-assessment-a1",
      [column]: mixedOwnerId,
    };
    await assertMixedOwnershipRejected(
      `INSERT INTO teras_reassessment_links
        (id, learner_id, pathway_id, original_gap_id, remediation_plan_id,
         practice_attempt_id, evidence_id, reassessment_attempt_id, previous_assessment_attempt_id)
       VALUES ($1, 'learner-demo', 'path-a', $2, $3, $4, $5, $6, $7)`,
      [
        `causal-reassessment-invalid-${column}`,
        values.original_gap_id,
        values.remediation_plan_id,
        values.practice_attempt_id,
        values.evidence_id,
        values.reassessment_attempt_id,
        values.previous_assessment_attempt_id,
      ],
      "teras_reassessment_links_learner_ownership",
    );
  }
  await assertMixedOwnershipRejected(
    "UPDATE teras_reassessment_links SET previous_assessment_attempt_id = $1 WHERE id = $2",
    ["causal-assessment-b1", "causal-reassessment-valid"],
    "teras_reassessment_links_learner_ownership",
  );

  const immutableLearnerParents = [
    ["teras_practice_attempts", "causal-practice-a"],
    ["teras_evidence", "causal-evidence-a"],
    ["teras_gaps", "causal-gap-a"],
    ["teras_assessment_attempts", "causal-assessment-a1"],
  ] as const;
  for (const [table, id] of immutableLearnerParents) {
    await assertMixedOwnershipRejected(
      `UPDATE ${table} SET learner_id = 'causal-owner-b' WHERE id = $1`,
      [id],
      "teras_causal_parent_learner_ownership_immutable",
    );
  }
  await assertMixedOwnershipRejected(
    "UPDATE teras_evidence_reviews SET evidence_id = $1 WHERE id = $2",
    ["causal-evidence-b", "causal-review-a"],
    "teras_causal_review_evidence_immutable",
  );
  await assertMixedOwnershipRejected(
    "UPDATE teras_remediation_plans SET gap_id = $1 WHERE id = $2",
    ["causal-gap-b", "causal-plan-a"],
    "teras_causal_plan_gap_immutable",
  );

  console.info("Causal link ownership integration test passed");
} finally {
  await client.end();
}