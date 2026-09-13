import { runIsolatedIntegrationTest } from "./integration-schema-runner";

runIsolatedIntegrationTest({
  schemaPrefix: "trainer_preference_history",
  testFile: "./src/trainer-reminder-preference-history.integration.ts",
}).then(
  () => process.stdout.write("trainer reminder preference history integration passed\n"),
  (error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : error}\n`);
    process.exitCode = 1;
  },
);