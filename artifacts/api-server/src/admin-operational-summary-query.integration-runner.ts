import { runIsolatedIntegrationTest } from "./integration-schema-runner";

runIsolatedIntegrationTest({
  schemaPrefix: "admin_escalation_plan",
  testFile: "./src/admin-operational-summary-query.integration.ts",
  useEmptyDatabase: true,
  setupCommand: [
    "bash",
    "-c",
    "pnpm --filter @workspace/db run push-force && psql \"$DATABASE_URL\" -v ON_ERROR_STOP=1 -c 'DROP INDEX IF EXISTS teras_diagnostic_follow_up_reminder_resolved_history_idx' -f ../../lib/db/migrations/0042_trainer_reminder_escalation_audit_index.sql",
  ],
}).then(
  () => process.stdout.write("admin operational summary query integration passed\n"),
  error => {
    process.stderr.write(`${error instanceof Error ? error.stack : error}\n`);
    process.exitCode = 1;
  },
);