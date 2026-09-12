import { runIsolatedIntegrationTest } from "./integration-schema-runner";

runIsolatedIntegrationTest({
  schemaPrefix: "trainer_follow_up_reminders",
  testFile: "./src/trainer-follow-up-notifications.database-test.ts",
  setupCommand: [
    "bash", "-c",
    "psql \"${DATABASE_URL//+/%20}\" -v ON_ERROR_STOP=1 -c \"ALTER TABLE teras_diagnostic_recommendation_follow_ups ADD COLUMN IF NOT EXISTS idempotency_key text; ALTER TABLE teras_diagnostic_recommendation_follow_ups ADD COLUMN IF NOT EXISTS idempotency_fingerprint text;\" -f ../../lib/db/migrations/0029_trainer_reminder_preferences.sql -f ../../lib/db/migrations/0030_trainer_reminder_permanent_failures.sql",
  ],
}).then(
  () => process.stdout.write("trainer follow-up notification integration passed\n"),
  error => {
    process.stderr.write(`${error instanceof Error ? error.stack : error}\n`);
    process.exitCode = 1;
  },
);