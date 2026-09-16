import { runIsolatedIntegrationTest } from "./integration-schema-runner";

runIsolatedIntegrationTest({
  schemaPrefix: "admin_operational_summary",
  testFile: "./src/admin-operational-summary.integration.ts",
  setupCommand: [
    "bash",
    "-c",
    "psql \"${DATABASE_URL//+/%20}\" -v ON_ERROR_STOP=1 -c \"ALTER TABLE teras_diagnostic_recommendation_follow_ups ADD COLUMN IF NOT EXISTS idempotency_key text; ALTER TABLE teras_diagnostic_recommendation_follow_ups ADD COLUMN IF NOT EXISTS idempotency_fingerprint text;\" -f ../../lib/db/migrations/0030_trainer_reminder_permanent_failures.sql -f ../../lib/db/migrations/0036_trainer_reminder_failure_notifications.sql -f ../../lib/db/migrations/0041_trainer_reminder_failure_fallback.sql -f ../../lib/db/migrations/0042_trainer_reminder_escalation_audit_index.sql",
  ],
}).then(
  () => process.stdout.write("admin operational summary integration passed\n"),
  error => {
    process.stderr.write(`${error instanceof Error ? error.stack : error}\n`);
    process.exitCode = 1;
  },
);