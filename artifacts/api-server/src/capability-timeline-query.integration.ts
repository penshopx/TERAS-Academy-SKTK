import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";

const { Client } = pg;
const client = new Client({ connectionString: process.env.DATABASE_URL });

type PlanNode = {
  "Node Type": string;
  "Index Name"?: string;
  "Actual Rows": number;
  "Actual Loops": number;
  Plans?: PlanNode[];
};

function flatten(node: PlanNode): PlanNode[] {
  return [node, ...(node.Plans ?? []).flatMap(flatten)];
}

async function explain(query: string, values: unknown[]) {
  const result = await client.query<{ "QUERY PLAN": Array<{ Plan: PlanNode }> }>(
    `EXPLAIN (ANALYZE, FORMAT JSON, TIMING FALSE, SUMMARY FALSE) ${query}`,
    values,
  );
  return flatten(result.rows[0]!["QUERY PLAN"][0]!.Plan);
}

function assertBoundedIndexPlan(
  nodes: PlanNode[],
  indexName: string,
  maximumRowsRead: number,
) {
  const scan = nodes.find(node => node["Index Name"] === indexName);
  assert.ok(scan, `expected query plan to use ${indexName}; plan nodes: ${nodes.map(node => `${node["Node Type"]}:${node["Index Name"] ?? "-"}`).join(", ")}`);
  assert.ok(
    scan["Actual Rows"] * scan["Actual Loops"] <= maximumRowsRead,
    `${indexName} read ${scan["Actual Rows"] * scan["Actual Loops"]} rows, expected at most ${maximumRowsRead}`,
  );
}

test("timeline parent lookups stay index-bounded at representative volume", async () => {
  await client.connect();
  try {
    const seed = await client.query<{
      learner_id: string;
      pathway_id: string;
      module_id: string;
      task_id: string;
      reviewer_id: string;
      enrollment_id: string;
      template_id: string;
      competency_unit_id: string;
      framework_id: string;
    }>(`
      SELECT e.learner_id, e.pathway_id, e.module_id, e.task_id,
             e.learner_id AS reviewer_id, en.id AS enrollment_id, t.id AS template_id,
             u.id AS competency_unit_id, u.framework_id
      FROM teras_evidence e
      JOIN teras_enrollments en
        ON en.learner_id = e.learner_id AND en.pathway_id = e.pathway_id
      JOIN teras_diagnostic_templates t ON t.pathway_id = e.pathway_id
      JOIN teras_competency_units u ON u.framework_id = t.framework_id
      LIMIT 1
    `);
    assert.ok(seed.rows[0], "demo fixture must contain evidence and diagnostic catalogue prerequisites");
    const ids = seed.rows[0]!;

    await client.query(`
      INSERT INTO teras_people (id, name, initials, role)
      VALUES ('plan-noise-learner', 'Timeline plan noise learner', 'TP', 'learner')
    `);
    await client.query(`
      INSERT INTO teras_diagnostic_sessions
        (id, learner_id, enrollment_id, pathway_id, template_id, framework_id, status, progress, completed_at)
      VALUES
        ('plan-target-session', $1, $3, $2, $4, $5, 'completed', 100, now())
    `, [ids.learner_id, ids.pathway_id, ids.enrollment_id, ids.template_id, ids.framework_id]);
    await client.query(`
      INSERT INTO teras_diagnostic_profiles
        (id, session_id, learner_id, pathway_id, framework_id, framework_version, current_state, dimension_summaries)
      VALUES
        ('plan-target-profile', 'plan-target-session', $1, $2, $3, 'fixture', 'developing', '{}')
    `, [ids.learner_id, ids.pathway_id, ids.framework_id]);
    await client.query(`
      INSERT INTO teras_diagnostic_sessions
        (id, learner_id, enrollment_id, pathway_id, template_id, framework_id, status, progress, completed_at)
      SELECT 'plan-noise-session-' || n, $1, $3, $2, $4, $5, 'completed', 100, now()
      FROM generate_series(1, 2000) n
    `, [ids.learner_id, ids.pathway_id, ids.enrollment_id, ids.template_id, ids.framework_id]);
    await client.query(`
      INSERT INTO teras_diagnostic_profiles
        (id, session_id, learner_id, pathway_id, framework_id, framework_version, current_state, dimension_summaries)
      SELECT 'plan-noise-profile-' || n, 'plan-noise-session-' || n, $1, $2, $3,
             'fixture', 'developing', '{}'
      FROM generate_series(1, 2000) n
    `, [ids.learner_id, ids.pathway_id, ids.framework_id]);
    await client.query(`
      INSERT INTO teras_evidence (id, learner_id, pathway_id, module_id, task_id, title, type, description)
      SELECT 'plan-noise-evidence-' || n, 'plan-noise-learner', $1, $2, $3, 'Noise', 'Report', 'Noise'
      FROM generate_series(1, 4000) n
    `, [ids.pathway_id, ids.module_id, ids.task_id]);
    await client.query(`
      INSERT INTO teras_evidence_reviews (id, evidence_id, reviewer_id, status, quality)
      SELECT 'plan-noise-review-' || n, 'plan-noise-evidence-' || n, $1, 'Approved',
             '{"valid":true,"relevant":true,"sufficient":true,"traceable":true}'::jsonb
      FROM generate_series(1, 4000) n
    `, [ids.reviewer_id]);
    await client.query(`
      INSERT INTO teras_diagnostic_gaps (id, profile_id, competency_unit_id, framework_id, diagnosis, severity)
      SELECT 'plan-target-diagnostic-' || n, 'plan-target-profile', $1, $2, 'Gap', 'medium'
      FROM generate_series(1, 120) n
    `, [ids.competency_unit_id, ids.framework_id]);
    await client.query(`
      INSERT INTO teras_diagnostic_gaps (id, profile_id, competency_unit_id, framework_id, diagnosis, severity)
      SELECT 'plan-noise-diagnostic-' || n, 'plan-noise-profile-' || n, $1, $2, 'Noise', 'low'
      FROM generate_series(1, 2000) n
    `, [ids.competency_unit_id, ids.framework_id]);

    const gap = await client.query<{ id: string }>(`
      INSERT INTO teras_gaps (id, learner_id, pathway_id, capability, criterion, severity, priority, diagnosis, gate, recommended_action)
      VALUES ('plan-target-gap', $1, $2, 'Capability', 'Criterion', 'medium', 'medium', 'Gap', 'practice', 'Practice')
      RETURNING id
    `, [ids.learner_id, ids.pathway_id]);
    await client.query(`
      INSERT INTO teras_remediation_plans (id, gap_id, title, description)
      SELECT 'plan-target-plan-' || n, $1, 'Plan', 'Plan'
      FROM generate_series(1, 80) n
    `, [gap.rows[0]!.id]);
    await client.query(`
      INSERT INTO teras_remediation_activities (id, plan_id, title, description, type)
      SELECT 'plan-target-activity-' || n, 'plan-target-plan-' || n, 'Activity', 'Activity', 'practice'
      FROM generate_series(1, 80) n
    `);
    await client.query(`
      INSERT INTO teras_remediation_events (id, activity_id, status)
      SELECT 'plan-target-event-' || activity || '-' || event,
             'plan-target-activity-' || activity, 'In progress'
      FROM generate_series(1, 80) activity CROSS JOIN generate_series(1, 12) event
    `);
    await client.query(`
      ANALYZE teras_evidence_reviews;
      ANALYZE teras_diagnostic_gaps;
      ANALYZE teras_remediation_plans;
      ANALYZE teras_remediation_activities;
      ANALYZE teras_remediation_events;
    `);

    const reviewPlan = await explain(
      "SELECT * FROM teras_evidence_reviews WHERE evidence_id = ANY($1::text[])",
      [["plan-noise-evidence-1", "plan-noise-evidence-2"]],
    );
    assertBoundedIndexPlan(reviewPlan, "teras_evidence_reviews_parent_timeline_idx", 4);

    const diagnosticPlan = await explain(
      "SELECT * FROM teras_diagnostic_gaps WHERE profile_id = ANY($1::text[])",
      [["plan-target-profile"]],
    );
    assertBoundedIndexPlan(diagnosticPlan, "teras_diagnostic_gaps_profile_idx", 130);

    const remediationPlan = await explain(
      "SELECT * FROM teras_remediation_events WHERE activity_id = ANY($1::text[])",
      [["plan-target-activity-1", "plan-target-activity-2"]],
    );
    assertBoundedIndexPlan(remediationPlan, "teras_remediation_events_parent_timeline_idx", 30);
  } finally {
    await client.end();
  }
});