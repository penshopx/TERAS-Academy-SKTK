import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import pg from "pg";

const { Client } = pg;
const execFileAsync = promisify(execFile);
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

async function assertProtectionsInstalled(client: InstanceType<typeof Client>, run: string) {
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
    `${run} must leave every persistent protection function installed`,
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
    `${run} must leave every persistent protection trigger installed`,
  );
}

async function bootstrapAgain(run: number) {
  try {
    await execFileAsync("bash", ["scripts/bootstrap-database-protections.sh"], {
      cwd: new URL("../../..", import.meta.url),
      env: { ...process.env, DATABASE_URL: databaseUrl },
      maxBuffer: 10 * 1024 * 1024,
    });
  } catch (error) {
    const commandError = error as Error & { stdout?: string; stderr?: string };
    throw new Error(
      `Database protection bootstrap rerun ${run} failed.\n` +
      `${commandError.stdout ?? ""}${commandError.stderr ?? ""}`,
      { cause: error },
    );
  }
}

async function representativeData(client: InstanceType<typeof Client>) {
  const result = await client.query<{ snapshot: unknown }>(`
    SELECT jsonb_build_object(
      'programs', (SELECT jsonb_agg(to_jsonb(row) ORDER BY row.id)
                   FROM teras_programs row WHERE row.id = 'bootstrap-rerun-program'),
      'pathways', (SELECT jsonb_agg(to_jsonb(row) ORDER BY row.id)
                   FROM teras_pathways row WHERE row.id = 'bootstrap-rerun-pathway'),
      'modules', (SELECT jsonb_agg(to_jsonb(row) ORDER BY row.id)
                  FROM teras_modules row WHERE row.id = 'bootstrap-rerun-module'),
      'courses', (SELECT jsonb_agg(to_jsonb(row) ORDER BY row.id)
                  FROM teras_courses row WHERE row.id = 'bootstrap-rerun-course'),
      'courseModules', (SELECT jsonb_agg(to_jsonb(row) ORDER BY row.id)
                        FROM teras_course_modules row WHERE row.id = 'bootstrap-rerun-course-module'),
      'lessons', (SELECT jsonb_agg(to_jsonb(row) ORDER BY row.id)
                  FROM teras_lessons row WHERE row.id = 'bootstrap-rerun-lesson'),
      'people', (SELECT jsonb_agg(to_jsonb(row) ORDER BY row.id)
                 FROM teras_people row WHERE row.id = 'bootstrap-rerun-learner'),
      'enrollments', (SELECT jsonb_agg(to_jsonb(row) ORDER BY row.id)
                      FROM teras_enrollments row WHERE row.id = 'bootstrap-rerun-enrollment'),
      'activities', (SELECT jsonb_agg(to_jsonb(row) ORDER BY row.id)
                     FROM teras_learning_activities row WHERE row.id = 'bootstrap-rerun-activity'),
      'resources', (SELECT jsonb_agg(to_jsonb(row) ORDER BY row.id)
                    FROM teras_content_resources row WHERE row.id = 'bootstrap-rerun-resource'),
      'progress', (SELECT jsonb_agg(to_jsonb(row) ORDER BY row.id)
                   FROM teras_learning_resource_progress row WHERE row.id = 'bootstrap-rerun-progress'),
      'baselines', (SELECT jsonb_agg(to_jsonb(row) ORDER BY row.id)
                    FROM teras_learning_baselines row WHERE row.id = 'bootstrap-rerun-baseline'),
      'versions', (SELECT jsonb_agg(to_jsonb(row) ORDER BY row.id)
                   FROM teras_learning_baseline_versions row WHERE row.id = 'bootstrap-rerun-version'),
      'audit', (SELECT jsonb_agg(to_jsonb(row) ORDER BY row.id)
                FROM teras_learning_baseline_audit row WHERE row.id = 'bootstrap-rerun-audit')
    ) AS snapshot
  `);
  return result.rows[0]?.snapshot;
}

const client = new Client({ connectionString: databaseUrl });
await client.connect();
try {
  await assertProtectionsInstalled(client, "empty-database bootstrap");
  await client.query(`
    INSERT INTO teras_programs (id, domain, track, name, description, status)
    VALUES ('bootstrap-rerun-program', 'bootstrap-test', 'integration',
            'Bootstrap program', 'Representative existing program', 'active');
    INSERT INTO teras_pathways (id, program_id, name, type, purpose, outcome, status)
    VALUES ('bootstrap-rerun-pathway', 'bootstrap-rerun-program',
            'Bootstrap pathway', 'integration', 'Verify rerunnable protections',
            'Existing data remains intact', 'active');
    INSERT INTO teras_people (id, name, initials, email, role, organization)
    VALUES ('bootstrap-rerun-learner', 'Bootstrap Learner', 'BL',
            'bootstrap-rerun@example.test', 'learner', 'TERAS test');
    INSERT INTO teras_modules
      (id, program_id, pathway_id, sequence, code, name, capability, evidence,
       learning_outcomes, theory)
    VALUES ('bootstrap-rerun-module', 'bootstrap-rerun-program',
            'bootstrap-rerun-pathway', 1, 'BOOTSTRAP-M01', 'Bootstrap module',
            'Verify migration safety', 'Preserved rows',
            ARRAY['Existing data remains intact'], ARRAY['Idempotent migrations']);
    INSERT INTO teras_courses
      (id, program_id, pathway_id, title, description, status, sequence)
    VALUES ('bootstrap-rerun-course', 'bootstrap-rerun-program',
            'bootstrap-rerun-pathway', 'Bootstrap course',
            'Representative existing course', 'PUBLISHED', 1);
    INSERT INTO teras_course_modules
      (id, course_id, module_id, program_id, pathway_id, sequence, status)
    VALUES ('bootstrap-rerun-course-module', 'bootstrap-rerun-course',
            'bootstrap-rerun-module', 'bootstrap-rerun-program',
            'bootstrap-rerun-pathway', 1, 'PUBLISHED');
    INSERT INTO teras_lessons
      (id, course_module_id, program_id, pathway_id, title, description, sequence, status)
    VALUES ('bootstrap-rerun-lesson', 'bootstrap-rerun-course-module',
            'bootstrap-rerun-program', 'bootstrap-rerun-pathway',
            'Bootstrap lesson', 'Representative existing lesson', 1, 'PUBLISHED');
    INSERT INTO teras_enrollments (id, learner_id, program_id, pathway_id, status)
    VALUES ('bootstrap-rerun-enrollment', 'bootstrap-rerun-learner',
            'bootstrap-rerun-program', 'bootstrap-rerun-pathway', 'active');
    INSERT INTO teras_learning_activities
      (id, lesson_id, program_id, pathway_id, type, title, description, sequence)
    VALUES ('bootstrap-rerun-activity', 'bootstrap-rerun-lesson',
            'bootstrap-rerun-program', 'bootstrap-rerun-pathway',
            'READ', 'Bootstrap activity', 'Representative existing activity', 1);
    INSERT INTO teras_content_resources
      (id, activity_id, type, title, content, sequence)
    VALUES ('bootstrap-rerun-resource', 'bootstrap-rerun-activity',
            'TEXT', 'Bootstrap resource', 'Representative existing content', 1);
    INSERT INTO teras_learning_resource_progress
      (id, learner_id, enrollment_id, pathway_id, activity_id, resource_id, position)
    VALUES ('bootstrap-rerun-progress', 'bootstrap-rerun-learner',
            'bootstrap-rerun-enrollment', 'bootstrap-rerun-pathway',
            'bootstrap-rerun-activity', 'bootstrap-rerun-resource', 37);
    INSERT INTO teras_learning_baselines
      (id, code, name, description, version, status, created_by)
    VALUES ('bootstrap-rerun-baseline', 'BOOTSTRAP-RERUN', 'Bootstrap baseline',
            'Representative existing draft baseline', '1.0', 'draft', 'bootstrap-test');
    INSERT INTO teras_learning_baseline_versions
      (id, baseline_id, version, status, snapshot, created_by)
    VALUES ('bootstrap-rerun-version', 'bootstrap-rerun-baseline', 1, 'DRAFT',
            '{"representative":true}'::jsonb, 'bootstrap-test');
    INSERT INTO teras_learning_baseline_audit
      (id, baseline_id, version_id, action, actor_id, details)
    VALUES ('bootstrap-rerun-audit', 'bootstrap-rerun-baseline',
            'bootstrap-rerun-version', 'CREATE_DRAFT', 'bootstrap-test',
            '{"representative":true}'::jsonb);
  `);
  const beforeReruns = await representativeData(client);

  for (let run = 1; run <= 2; run += 1) {
    await bootstrapAgain(run);
    assert.deepEqual(
      await representativeData(client),
      beforeReruns,
      `database protection bootstrap rerun ${run} must preserve representative existing data`,
    );
    await assertProtectionsInstalled(client, `database protection bootstrap rerun ${run}`);
  }
} finally {
  await client.end();
}
