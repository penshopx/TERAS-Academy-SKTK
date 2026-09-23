import { runIsolatedIntegrationTest } from "./integration-schema-runner";

runIsolatedIntegrationTest({
  schemaPrefix: "admin_operational_summary",
  testFile: "./src/admin-operational-summary.integration.ts",
  useEmptyDatabase: true,
  setupCommand: [
    "bash",
    "-c",
    "pnpm --filter @workspace/db run push-force && psql \"$DATABASE_URL\" -v ON_ERROR_STOP=1 -f ../../lib/db/migrations/0042_trainer_reminder_escalation_audit_index.sql",
  ],
}).then(
  () => process.stdout.write("admin operational summary integration passed\n"),
  error => {
    process.stderr.write(`${error instanceof Error ? error.stack : error}\n`);
    process.exitCode = 1;
  },
);