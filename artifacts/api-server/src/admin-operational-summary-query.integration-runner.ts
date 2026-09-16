import { runIsolatedIntegrationTest } from "./integration-schema-runner";

runIsolatedIntegrationTest({
  schemaPrefix: "admin_escalation_plan",
  testFile: "./src/admin-operational-summary-query.integration.ts",
  setupCommand: [
    "bash",
    "-c",
    "psql \"${DATABASE_URL//+/%20}\" -v ON_ERROR_STOP=1 -f ../../lib/db/migrations/0042_trainer_reminder_escalation_audit_index.sql",
  ],
}).then(
  () => process.stdout.write("admin operational summary query integration passed\n"),
  error => {
    process.stderr.write(`${error instanceof Error ? error.stack : error}\n`);
    process.exitCode = 1;
  },
);