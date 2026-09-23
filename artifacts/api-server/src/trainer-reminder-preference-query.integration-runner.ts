import { runIsolatedIntegrationTest } from "./integration-schema-runner";

runIsolatedIntegrationTest({
  schemaPrefix: "trainer_preference_plan",
  testFile: "./src/trainer-reminder-preference-query.integration.ts",
  useEmptyDatabase: true,
  setupCommand: [
    "bash",
    "-c",
    "pnpm --filter @workspace/db run push-force && psql \"$DATABASE_URL\" -v ON_ERROR_STOP=1 -c 'DROP INDEX IF EXISTS teras_trainer_reminder_preferences_trainer_created_id_idx' -f ../../lib/db/migrations/0029_trainer_reminder_preferences.sql",
  ],
}).then(
  () => process.stdout.write("trainer reminder preference query plan passed\n"),
  error => {
    process.stderr.write(`${error instanceof Error ? error.stack : error}\n`);
    process.exitCode = 1;
  },
);