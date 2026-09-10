import { runIsolatedIntegrationTest } from "./integration-schema-runner";

runIsolatedIntegrationTest({
  schemaPrefix: "trainer_follow_up_reminders",
  testFile: "./src/trainer-follow-up-notifications.database-test.ts",
}).then(
  () => process.stdout.write("trainer follow-up notification integration passed\n"),
  error => {
    process.stderr.write(`${error instanceof Error ? error.stack : error}\n`);
    process.exitCode = 1;
  },
);