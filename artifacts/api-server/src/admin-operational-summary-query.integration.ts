import assert from "node:assert/strict";
import pg from "pg";
import { createIntegrationTestApp } from "./integration-test-app";
import {
  buildReminderEscalationCountQuery,
  buildOpenReminderEscalationIdsQuery,
  buildResolvedReminderEscalationIdsQuery,
} from "./routes/admin";

const { Client } = pg;
const client = new Client({ connectionString: process.env.DATABASE_URL });
const OPEN_COUNT = 12_000;
const RESOLVED_COUNT = 8_000;

type PlanNode = {
  "Node Type": string;
  "Index Name"?: string;
  "Actual Rows": number;
  "Actual Loops": number;
  "Rows Removed by Filter"?: number;
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

function assertIndexPlan(nodes: PlanNode[], indexName: string, maximumRowsRead: number) {
  const scan = nodes.find(node => node["Index Name"] === indexName);
  assert.ok(
    scan,
    `expected ${indexName}; plan nodes: ${nodes.map(node => `${node["Node Type"]}:${node["Index Name"] ?? "-"}`).join(", ")}`,
  );
  const rowsRead = (scan["Actual Rows"] + (scan["Rows Removed by Filter"] ?? 0)) * scan["Actual Loops"];
  assert.ok(rowsRead <= maximumRowsRead, `${indexName} read ${rowsRead} candidates, expected at most ${maximumRowsRead}`);
}

function assertSinglePassCountPlan(nodes: PlanNode[], maximumRowsRead: number) {
  const scans = nodes.filter(node => node["Node Type"].includes("Scan"));
  const rowsRead = scans.reduce(
    (total, scan) => total + (scan["Actual Rows"] + (scan["Rows Removed by Filter"] ?? 0)) * scan["Actual Loops"],
    0,
  );
  assert.ok(
    rowsRead <= maximumRowsRead,
    `count query read ${rowsRead} candidates, expected a single pass of at most ${maximumRowsRead}`,
  );
  assert.ok(scans.every(scan => scan["Actual Loops"] === 1), "count query must not execute correlated scan loops");
}

async function run() {
  await client.connect();
  const app = createIntegrationTestApp(() => ({ userId: "escalation-plan-admin", role: null }));
  const server = await new Promise<ReturnType<typeof app.listen>>(resolve => {
    const listener = app.listen(0, () => resolve(listener));
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string", "test server did not bind");

  try {
    await client.query(`
      INSERT INTO teras_people (id, name, initials, role, status, auth_provider, auth_subject)
      VALUES
        ('escalation-plan-admin', 'Escalation Plan Admin', 'EA', 'admin', 'active', 'supabase', 'escalation-plan-admin'),
        ('escalation-plan-trainer', 'Escalation Plan Trainer', 'ET', 'trainer', 'active', NULL, NULL);
      INSERT INTO teras_person_roles (person_id, role) VALUES ('escalation-plan-admin', 'admin');
      INSERT INTO teras_programs (id, domain, name, description, status)
      VALUES ('escalation-plan-program', 'test', 'Escalation plan', 'test', 'active');
      INSERT INTO teras_pathways (id, program_id, name, type, outcome, status)
      VALUES ('escalation-plan-path', 'escalation-plan-program', 'Escalation plan', 'test', 'test', 'active');
      INSERT INTO teras_competency_frameworks (id, code, name, description, version, status)
      VALUES ('escalation-plan-framework', 'EP', 'Escalation plan', 'test', '1', 'active');
      INSERT INTO teras_diagnostic_templates
        (id, framework_id, pathway_id, version, name, description, status)
      VALUES
        ('escalation-plan-template', 'escalation-plan-framework', 'escalation-plan-path', '1', 'Escalation plan', 'test', 'published');
      INSERT INTO teras_enrollments (id, learner_id, program_id, pathway_id, status)
      VALUES ('escalation-plan-enrollment', 'escalation-plan-admin', 'escalation-plan-program', 'escalation-plan-path', 'completed');
      INSERT INTO teras_diagnostic_sessions
        (id, learner_id, enrollment_id, pathway_id, template_id, framework_id, status, progress)
      VALUES
        ('escalation-plan-session', 'escalation-plan-admin', 'escalation-plan-enrollment', 'escalation-plan-path',
         'escalation-plan-template', 'escalation-plan-framework', 'completed', 100);
      INSERT INTO teras_diagnostic_profiles
        (id, session_id, learner_id, pathway_id, framework_id, framework_version, current_state)
      VALUES
        ('escalation-plan-profile', 'escalation-plan-session', 'escalation-plan-admin', 'escalation-plan-path',
         'escalation-plan-framework', '1', 'practice');

      INSERT INTO teras_diagnostic_recommendations
        (id, profile_id, framework_id, kind, title, rationale, priority)
      SELECT 'escalation-plan-recommendation-' || n, 'escalation-plan-profile', 'escalation-plan-framework',
             'practice', 'Escalation target ' || n, 'test', 'high'
      FROM generate_series(1, ${OPEN_COUNT + RESOLVED_COUNT}) n;

      INSERT INTO teras_diagnostic_recommendation_follow_ups
        (id, recommendation_id, trainer_id, status, target_at, note)
      SELECT 'escalation-plan-follow-up-' || n, 'escalation-plan-recommendation-' || n,
             'escalation-plan-trainer', 'planned', now(), 'test'
      FROM generate_series(1, ${OPEN_COUNT + RESOLVED_COUNT}) n;

      INSERT INTO teras_diagnostic_follow_up_reminder_deliveries
        (id, follow_up_id, trainer_id, channel, reminder_kind, destination, status, attempt_count, last_attempt_at, failure_reason)
      SELECT 'escalation-plan-delivery-' || lpad(n::text, 5, '0'), 'escalation-plan-follow-up-' || n,
             'escalation-plan-trainer', 'email', 'overdue', 'trainer@example.test',
             'permanently_failed', 3,
             CASE
               WHEN n <= ${OPEN_COUNT} THEN now() - ((${OPEN_COUNT + RESOLVED_COUNT} + n) || ' seconds')::interval
               ELSE now() - ((n - ${OPEN_COUNT}) || ' milliseconds')::interval
             END,
             'private transport detail'
      FROM generate_series(1, ${OPEN_COUNT + RESOLVED_COUNT}) n;

      INSERT INTO teras_diagnostic_follow_up_reminder_resolutions
        (id, reminder_delivery_id, note, resolved_by_person_id, resolved_at)
      SELECT 'escalation-plan-resolution-' || n,
             'escalation-plan-delivery-' || lpad((${OPEN_COUNT} + n)::text, 5, '0'),
             'resolved', 'escalation-plan-admin', now() - (n || ' seconds')::interval
      FROM generate_series(1, ${RESOLVED_COUNT}) n;

      UPDATE teras_diagnostic_follow_up_reminder_deliveries delivery
      SET escalation_resolved_at = resolution.resolved_at
      FROM teras_diagnostic_follow_up_reminder_resolutions resolution
      WHERE resolution.reminder_delivery_id = delivery.id;

      ANALYZE teras_diagnostic_follow_up_reminder_deliveries;
      ANALYZE teras_diagnostic_follow_up_reminder_resolutions;
    `);

    const summaryResponse = await fetch(`http://127.0.0.1:${address.port}/api/admin/summary`);
    const summaryBody = await summaryResponse.text();
    assert.equal(summaryResponse.status, 200, summaryBody);
    const summary = JSON.parse(summaryBody) as any;
    assert.equal(summary.failedTrainerReminders.length, 25, "summary escalation details must remain bounded");
    assert.equal(summary.reminderEscalationCounts.open, OPEN_COUNT, "summary must count every open escalation");
    assert.equal(summary.reminderEscalationCounts.resolved, RESOLVED_COUNT, "summary must count every resolved escalation");
    assert.equal(summary.reminderEscalationCounts.total, OPEN_COUNT + RESOLVED_COUNT);
    assert.ok(summary.failedTrainerReminders.every((item: any) => item.status === "open"), "summary must prioritize open escalations");
    assert.ok(
      summary.failedTrainerReminders.every((item: any) => new Date(item.lastAttemptAt).getTime() < Date.now() - 10_000_000),
      "summary must prioritize older open escalations over newer resolved escalations",
    );

    const resolvedResponse = await fetch(
      `http://127.0.0.1:${address.port}/api/admin/reminder-escalations?status=resolved&limit=25&offset=25`,
    );
    assert.equal(resolvedResponse.status, 200);
    const resolved = await resolvedResponse.json() as any;
    assert.equal(resolved.items.length, 25, "resolved history must honor page size");
    assert.equal(resolved.pagination.total, RESOLVED_COUNT, "resolved history must retain its complete count");
    assert.equal(resolved.pagination.offset, 25);
    assert.equal(resolved.pagination.hasMore, true);

    const openSql = buildOpenReminderEscalationIdsQuery({ limit: 25 }).toSQL();
    const openPlan = await explain(openSql.sql, openSql.params);
    assertIndexPlan(openPlan, "teras_diagnostic_follow_up_reminder_failed_history_idx", 50);

    const resolvedSql = buildResolvedReminderEscalationIdsQuery({ limit: 25 }).toSQL();
    const resolvedPlan = await explain(resolvedSql.sql, resolvedSql.params);
    assertIndexPlan(resolvedPlan, "teras_diagnostic_follow_up_reminder_resolved_history_idx", 50);

    const countSql = buildReminderEscalationCountQuery().toSQL();
    const countPlan = await explain(countSql.sql, countSql.params);
    assertSinglePassCountPlan(countPlan, OPEN_COUNT + RESOLVED_COUNT + 10);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await client.end();
  }
}

await run();